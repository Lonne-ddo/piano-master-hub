// ─── POST /api/admin/shorts/extract ──────────────────────────────
// Pipeline complet : Groq Whisper (verbose_json + timestamps) → Claude
// Sonnet (identifie 3-7 passages postables 15-60s) → save KV.
//
// Réponse SSE (event-stream) avec heartbeats keepalive 10s pour éviter
// timeout CF Pages 30s. Events :
//   { step: 'transcribing' }
//   { step: 'analyzing', segmentsCount }
//   { step: 'done', id, passages }
//   { error: '...', status }
//
// Auth admin via cookie mh_admin_pw.

import { requireAdminPassword } from '../../_lib/session.js';

const MODEL_WHISPER = 'whisper-large-v3';
const MODEL_CLAUDE = 'claude-sonnet-4-6';
const KV_KEY_PREFIX = 'shorts:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

const ALLOWED_MIME = [
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-flac',
  'video/mp4', 'video/quicktime', 'video/webm',
];
const MAX_BYTES = 100 * 1024 * 1024;

function genId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += alphabet[buf[i] & 63];
  return out;
}

const SHORTS_SYSTEM_PROMPT = `Tu es un éditeur de contenu social media spécialisé piano/musique. Tu reçois la transcription d'un cours ou d'une conversation prof-élève piano avec timecodes. Identifie 3 à 7 passages qui formeraient un clip court (<60s, idéalement 20-45s) postable sur Instagram Reels, YouTube Shorts ou TikTok.

CRITÈRES STRICTS :
- Self-contained : le passage doit pouvoir être compris seul, sans contexte amont/aval. Démarre sur une phrase qui pose le sujet, finit sur une conclusion ou un punchline.
- 1 idée claire par clip : un concept pédagogique, une réponse à une question, une anecdote, une démo, une révélation surprenante.
- Hookable : le passage doit avoir une "accroche" dans les 3 premières secondes (question, statement fort, problème nommé).
- Pas de filler : pas de "euh", "donc voilà", "vous voyez" en début ou fin. Trim aux frontières naturelles.
- Durée : 15-60s strict. Sous 15s = pas assez de matière. Au-dessus de 60s = pas postable en short.

TYPES POSSIBLES :
- "explication" : Lonne explique un concept (ex. "pourquoi le m7b5 sonne triste")
- "qa" : élève pose une question + Lonne répond
- "demo" : Lonne fait une démonstration auditive d'un accord/voicing
- "anecdote" : un mini-récit pédagogique ou une analogie
- "punchline" : une révélation ou un statement contre-intuitif

OUTPUT (JSON array strict, AUCUN texte ni markdown wrapper hors du JSON) :
[
  {
    "start_ms": 12500,
    "end_ms": 47000,
    "transcript": "le texte exact du passage",
    "type": "explication",
    "hook_title": "Titre punchy 5-8 mots, premier mot fort",
    "accroche": "Phrase d'ouverture suggérée 1-2 phrases, à dire par-dessus la vidéo en intro pour capter l'attention",
    "raison": "Pourquoi ce passage marche en short, 1 phrase courte"
  }
]

Classe par potentiel hook descendant (le meilleur en premier).
Si l'audio n'a vraiment aucun passage qualifiable, retourne [].`;

function extractJson(text) {
  if (!text) return '[]';
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  // Si le LLM a wrappé dans un objet, essaye de trouver le premier array
  if (s.startsWith('{')) {
    const arrStart = s.indexOf('[');
    const arrEnd = s.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) s = s.slice(arrStart, arrEnd + 1);
  }
  return s;
}

const VALID_TYPES = new Set(['explication', 'qa', 'demo', 'anecdote', 'punchline']);

function validatePassages(rawList) {
  if (!Array.isArray(rawList)) return [];
  const cleaned = [];
  for (const p of rawList) {
    if (!p || typeof p !== 'object') continue;
    const start_ms = Number(p.start_ms);
    const end_ms = Number(p.end_ms);
    if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms)) continue;
    if (end_ms <= start_ms) continue;
    const dur = end_ms - start_ms;
    if (dur < 15000 || dur > 60000) continue;
    const transcript = typeof p.transcript === 'string' ? p.transcript.trim().slice(0, 2000) : '';
    if (!transcript) continue;
    const type = (typeof p.type === 'string' && VALID_TYPES.has(p.type.toLowerCase()))
      ? p.type.toLowerCase() : 'explication';
    const hook_title = typeof p.hook_title === 'string' ? p.hook_title.trim().slice(0, 120) : '';
    const accroche = typeof p.accroche === 'string' ? p.accroche.trim().slice(0, 400) : '';
    const raison = typeof p.raison === 'string' ? p.raison.trim().slice(0, 200) : '';
    cleaned.push({
      start_ms: Math.round(start_ms),
      end_ms: Math.round(end_ms),
      duration_ms: Math.round(dur),
      transcript,
      type,
      hook_title,
      accroche,
      raison,
    });
  }
  return cleaned;
}

async function callClaudeForShorts(apiKey, transcriptWithTs, opts = {}) {
  const userMessage = `Voici la transcription du cours avec les timestamps de chaque segment (start_ms - end_ms). Identifie les passages postables selon les critères. Retourne uniquement le JSON array.\n\n${transcriptWithTs}`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_CLAUDE,
      max_tokens: 6000,
      temperature: 0.3,
      system: SHORTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Claude: empty response');
  return text;
}

function segmentsToTranscript(segments) {
  return segments
    .map((s) => {
      const startMs = Math.round(Number(s.start || 0) * 1000);
      const endMs = Math.round(Number(s.end || 0) * 1000);
      return `[${startMs}-${endMs}] ${String(s.text || '').trim()}`;
    })
    .join('\n');
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!env.GROQ_API_KEY) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY missing' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!env.MASTERHUB_HISTORY) {
    return new Response(JSON.stringify({ error: 'kv_not_bound' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let formData;
  try { formData = await request.formData(); }
  catch {
    return new Response(JSON.stringify({ error: 'invalid_multipart' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const file = formData.get('audio') || formData.get('file');
  if (!file || typeof file === 'string') {
    return new Response(JSON.stringify({ error: 'file_missing' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (file.size > MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'file_too_large', maxBytes: MAX_BYTES }), {
      status: 413, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!ALLOWED_MIME.includes(file.type)) {
    return new Response(JSON.stringify({ error: 'mime_not_allowed', mimeType: file.type, allowed: ALLOWED_MIME }), {
      status: 415, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const title = String(formData.get('title') || file.name || 'Extract').slice(0, 200);

  // ── SSE stream avec heartbeats ──
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch {}
      }, 10000);

      const emit = (payload) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); } catch {}
      };

      const abortCtrl = new AbortController();
      const tid = setTimeout(() => abortCtrl.abort(), 180000); // 3 min hard timeout

      try {
        // 1) Transcribe Groq Whisper
        emit({ step: 'transcribing' });
        const groqForm = new FormData();
        groqForm.append('file', file);
        groqForm.append('model', MODEL_WHISPER);
        groqForm.append('response_format', 'verbose_json');
        groqForm.append('timestamp_granularities[]', 'segment');
        groqForm.append('prompt',
          "Cours de piano en français avec Estelon. Vocabulaire : accords maj7 min7 m7b5 sus2 sus4, voicings, renversements, tritons, tensions, degrés I II V I, gammes, modulations, arpèges, ear training, métronome.");

        const groqResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: groqForm,
          signal: abortCtrl.signal,
        });
        if (!groqResp.ok) {
          const errText = await groqResp.text().catch(() => '');
          emit({ error: `Groq ${groqResp.status}: ${errText.slice(0, 200)}`, status: groqResp.status });
          clearInterval(heartbeat); clearTimeout(tid);
          try { controller.close(); } catch {}
          return;
        }
        const groqData = await groqResp.json();
        const segments = Array.isArray(groqData?.segments) ? groqData.segments : [];
        const audioDurationMs = segments.length
          ? Math.round(Number(segments[segments.length - 1].end || 0) * 1000)
          : 0;

        // 2) Analyze with Claude
        emit({ step: 'analyzing', segmentsCount: segments.length });
        const transcriptWithTs = segmentsToTranscript(segments);
        if (!transcriptWithTs.trim()) {
          emit({ error: 'empty_transcript', status: 422 });
          clearInterval(heartbeat); clearTimeout(tid);
          try { controller.close(); } catch {}
          return;
        }

        let claudeRaw;
        try {
          claudeRaw = await callClaudeForShorts(env.ANTHROPIC_API_KEY, transcriptWithTs);
        } catch (e) {
          // Retry 1× avec un nudge plus strict
          try {
            claudeRaw = await callClaudeForShorts(env.ANTHROPIC_API_KEY,
              transcriptWithTs + '\n\nRappel : renvoie UNIQUEMENT un JSON array valide, sans markdown, sans texte autour.');
          } catch (e2) {
            emit({ error: `Claude: ${e2?.message || 'failed'}`, status: 502 });
            clearInterval(heartbeat); clearTimeout(tid);
            try { controller.close(); } catch {}
            return;
          }
        }

        // 3) Parse + validate
        let rawList;
        try {
          rawList = JSON.parse(extractJson(claudeRaw));
        } catch (e) {
          emit({ error: `Claude JSON parse failed: ${e?.message || ''}`, status: 502, claudeRawSnippet: String(claudeRaw).slice(0, 300) });
          clearInterval(heartbeat); clearTimeout(tid);
          try { controller.close(); } catch {}
          return;
        }
        const passages = validatePassages(rawList);

        // 4) Save KV
        const id = genId();
        const record = {
          id,
          title,
          originalFilename: String(file.name || ''),
          mimeType: file.type,
          sizeBytes: file.size,
          audioDurationMs,
          passages,
          segmentsCount: segments.length,
          createdAt: Date.now(),
        };
        try {
          await env.MASTERHUB_HISTORY.put(KV_KEY_PREFIX + id, JSON.stringify(record));
        } catch (e) {
          emit({ error: `KV put failed: ${e?.message || ''}`, status: 500 });
          clearInterval(heartbeat); clearTimeout(tid);
          try { controller.close(); } catch {}
          return;
        }

        emit({ step: 'done', id, title, passages, audioDurationMs });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          emit({ error: 'timeout (>180s)', status: 408 });
        } else {
          emit({ error: `Pipeline error: ${err?.message || ''}`, status: 500 });
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(tid);
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
