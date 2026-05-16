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

const SHORTS_SYSTEM_PROMPT = `Tu es un éditeur de contenu social media spécialisé piano/musique. Tu reçois la transcription d'un cours ou d'une conversation prof-élève piano avec timecodes. Identifie les passages qui formeraient un clip court (<60s, idéalement 20-45s) postable sur Instagram Reels, YouTube Shorts ou TikTok.

PRIORITÉ ABSOLUE : CLARTÉ DE L'EXPLICATION.
Un passage à 95 doit :
- Livrer un concept piano de manière propre et fluide
- Sans bafouillage majeur, sans hésitation longue
- Avec une structure naturelle : pose le problème → explique → conclut
- Compréhensible par un débutant-intermédiaire en piano

CRITÈRES STRICTS :
- Self-contained : le passage doit pouvoir être compris seul, sans contexte amont/aval. Démarre sur une phrase qui pose le sujet, finit sur une conclusion ou un punchline.
- 1 idée claire par clip : un concept pédagogique, une réponse à une question, une anecdote, une démo, une révélation surprenante.
- Hookable : le passage doit avoir une "accroche" dans les 3 premières secondes (question, statement fort, problème nommé).
- Pas de filler : pas de "euh", "donc voilà", "vous voyez" en début ou fin. Trim aux frontières naturelles.
- Durée : 15-60s strict. Sous 15s = pas assez de matière. Au-dessus de 60s = pas postable en short.

SCORING (entier 0-100) :
- 90+ : exceptionnel, à publier en priorité (clair, hookable, self-contained, punchy)
- 75-89 : très bon, vaut le coup (clair + au moins 2 autres critères)
- 60-74 : bon, publiable (clair mais manque de hook OU pas parfaitement self-contained)
- < 60 : NE PAS RETOURNER ce passage (filtre-le toi-même).

TYPES POSSIBLES :
- "explication" : Lonne explique un concept (ex. "pourquoi le m7b5 sonne triste")
- "qa" : élève pose une question + Lonne répond
- "demo" : Lonne fait une démonstration auditive d'un accord/voicing
- "anecdote" : un mini-récit pédagogique ou une analogie
- "punchline" : une révélation ou un statement contre-intuitif

OVERLAY_CAPTION (NOUVEAU CHAMP) :
Phrase courte (5-12 mots), punchy, à afficher en INCRUSTATION GRAPHIQUE sur la vidéo verticale Reel/TikTok.
DIFFÉRENT du hook_title (titre style thumbnail YouTube) et de l'accroche (script parlé en intro).
Objectif : arrêter le scroll en 1 seconde. Caractéristiques :
- 5-12 mots strict, doit tenir en 2 lignes max sur écran vertical
- Claim FORT, affirmation marquante OU promesse claire OU statement contre-intuitif
- Pas de jargon technique piano hyper pointu (doit intriguer même un non-pianiste)
- Pas de question rhétorique molle ("Tu connais ce truc ?") — préférer une affirmation
- Style "scroll-stop"

Exemples :
- "Personne ne t'apprendra ça mais ça change ta façon de jouer"
- "Le pire accord à éviter quand tu débutes"
- "L'astuce gospel que 99% des pianistes ignorent"
- "Cet accord va transformer ton jeu"
- "Comment sonner pro en 30 secondes"
- "Tu joues toujours les mêmes accords ? Voilà pourquoi"

OUTPUT (JSON array strict, AUCUN texte ni markdown wrapper hors du JSON) :
[
  {
    "start_ms": 12500,
    "end_ms": 47000,
    "transcript": "le texte exact du passage",
    "type": "explication",
    "hook_title": "Titre punchy 5-8 mots, premier mot fort",
    "overlay_caption": "Personne ne t'apprendra ça mais ça change ta façon de jouer",
    "accroche": "Phrase d'ouverture suggérée 1-2 phrases, à dire par-dessus la vidéo en intro pour capter l'attention",
    "raison": "Pourquoi ce passage marche en short, 1 phrase courte",
    "score": 87
  }
]

Filtre toi-même les passages < 60 avant de retourner.
Trie par score descendant strict (le meilleur en premier).
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
    const overlay_caption = typeof p.overlay_caption === 'string' ? p.overlay_caption.trim().slice(0, 200) : '';
    const accroche = typeof p.accroche === 'string' ? p.accroche.trim().slice(0, 400) : '';
    const raison = typeof p.raison === 'string' ? p.raison.trim().slice(0, 200) : '';
    // Score 0-100, clamp + filter < 60 (sécurité backend si Claude oublie de filtrer)
    let score = Number(p.score);
    if (!Number.isFinite(score)) score = 60;
    score = Math.max(0, Math.min(100, Math.round(score)));
    if (score < 60) continue;
    cleaned.push({
      start_ms: Math.round(start_ms),
      end_ms: Math.round(end_ms),
      duration_ms: Math.round(dur),
      transcript,
      type,
      hook_title,
      overlay_caption,
      accroche,
      raison,
      score,
    });
  }
  // Tri score desc (sécurité backend si Claude n'a pas trié)
  cleaned.sort((a, b) => (b.score || 0) - (a.score || 0));
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
  if (!env.ANALYSE_R2) {
    return new Response(JSON.stringify({ error: 'r2_not_bound' }), {
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

  // Multi-file : audio[] répété N fois dans l'ordre. Fallback single 'audio'/'file'.
  let files = formData.getAll('audio[]').filter((f) => f && typeof f !== 'string');
  if (!files.length) files = formData.getAll('audio').filter((f) => f && typeof f !== 'string');
  if (!files.length) {
    const single = formData.get('audio') || formData.get('file');
    if (single && typeof single !== 'string') files = [single];
  }
  if (!files.length) {
    return new Response(JSON.stringify({ error: 'file_missing' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  // Validation par fichier
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      return new Response(JSON.stringify({ error: 'file_too_large', filename: f.name, maxBytes: MAX_BYTES }), {
        status: 413, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      return new Response(JSON.stringify({ error: 'mime_not_allowed', filename: f.name, mimeType: f.type, allowed: ALLOWED_MIME }), {
        status: 415, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  // Métadonnées parts (durations côté client pour fallback si Whisper ne fournit pas
  // un end précis). Format JSON : [{ name, durationMs, offsetMs }, ...].
  let partsMetadata = [];
  try {
    const raw = formData.get('parts_metadata');
    if (typeof raw === 'string' && raw) partsMetadata = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(partsMetadata)) partsMetadata = [];

  // Hard cap durée totale 2h30 (Whisper parallèle absorbe les longs audios).
  // Worst case Groq Whisper sur 2h en parallèle : ~90s + Claude 30s = sous
  // le timeout 240s du stream serveur (cf abortCtrl ci-dessous).
  const totalMetaMs = partsMetadata.reduce((acc, p) => acc + (Number(p?.durationMs) || 0), 0);
  if (totalMetaMs > 150 * 60 * 1000) {
    return new Response(JSON.stringify({ error: 'total_duration_too_long', maxMinutes: 150 }), {
      status: 413, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const title = String(formData.get('title') || files[0].name || 'Extract').slice(0, 200);

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
      const tid = setTimeout(() => abortCtrl.abort(), 240000); // 4 min hard timeout (multi-file)

      // ID généré tôt pour préfixer les keys R2 (shorts/<id>/part_N.ext)
      const recordId = genId();
      // ext par MIME pour le naming R2
      const EXT_BY_MIME = {
        'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
        'audio/wav': 'wav', 'audio/x-wav': 'wav',
        'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/aac': 'm4a',
        'audio/flac': 'flac', 'audio/x-flac': 'flac',
        'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
      };

      // Helper : transcrit 1 fichier Groq Whisper.
      async function transcribeOne(file) {
        const gf = new FormData();
        gf.append('file', file);
        gf.append('model', MODEL_WHISPER);
        gf.append('response_format', 'verbose_json');
        gf.append('timestamp_granularities[]', 'segment');
        gf.append('prompt',
          "Cours de piano en français avec Estelon. Vocabulaire : accords maj7 min7 m7b5 sus2 sus4, voicings, renversements, tritons, tensions, degrés I II V I, gammes, modulations, arpèges, ear training, métronome.");
        const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: gf,
          signal: abortCtrl.signal,
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          throw new Error(`Groq ${r.status}: ${errText.slice(0, 200)}`);
        }
        const data = await r.json();
        const segs = Array.isArray(data?.segments) ? data.segments : [];
        const lastEndMs = segs.length ? Math.round(Number(segs[segs.length - 1].end || 0) * 1000) : 0;
        return { segments: segs, durationMs: lastEndMs };
      }

      try {
        // 1) Transcription Whisper + Upload R2 en parallèle (Promise.allSettled
        //    indépendants). Le upload R2 ne bloque pas le SSE : il tourne
        //    pendant que Whisper transcribe.
        emit({ step: 'transcribing', total: files.length });

        async function uploadOneToR2(file, index) {
          const ext = EXT_BY_MIME[file.type] || 'bin';
          const key = `shorts/${recordId}/part_${index}.${ext}`;
          try {
            await env.ANALYSE_R2.put(key, file.stream(), {
              httpMetadata: { contentType: file.type },
            });
            return { ok: true, key, mimeType: file.type };
          } catch (e) {
            console.warn('[shorts] R2 upload failed', key, e?.message || e);
            return { ok: false, key: null, error: e?.message || 'r2_put_failed' };
          }
        }

        const [transcriptions, uploads] = await Promise.all([
          Promise.allSettled(files.map(transcribeOne)),
          Promise.allSettled(files.map((f, i) => uploadOneToR2(f, i))),
        ]);
        let results = transcriptions;

        // Retry séquentiel pour les 429 (rate limit Groq) — on attend 1.5s
        // entre chaque retry pour laisser la limite se reset.
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'fulfilled') continue;
          const msg = String(results[i].reason?.message || '');
          if (!/429|rate.?limit/i.test(msg)) continue;
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const v = await transcribeOne(files[i]);
            results[i] = { status: 'fulfilled', value: v };
            emit({ step: 'retried_part', index: i, filename: files[i].name });
          } catch (e) {
            results[i] = { status: 'rejected', reason: e };
          }
        }

        // Émet heartbeat application après chaque batch (déjà finis quand on
        // arrive ici, mais le keepalive a tourné en parallèle, donc OK).
        for (let i = 0; i < results.length; i++) {
          emit({
            step: 'transcribed_part',
            index: i,
            status: results[i].status,
            filename: files[i].name,
          });
        }

        // 2) Échec si TOUS fails. Si certains échouent, on les skip et continue.
        const okCount = results.filter((r) => r.status === 'fulfilled').length;
        if (okCount === 0) {
          const firstErr = results[0]?.reason?.message || 'all_failed';
          emit({ error: `Transcription : ${firstErr}`, status: 502 });
          clearInterval(heartbeat); clearTimeout(tid);
          try { controller.close(); } catch {}
          return;
        }

        // 3) Apply offsets cumulés selon l'ordre des files (qui = ordre upload admin).
        //    Pour chaque part : durationMs réel = client metadata si fourni, sinon
        //    le dernier end Whisper. offsetMs = somme des durations précédentes.
        const allSegments = [];
        const partsForKV = [];
        let cumulativeOffsetMs = 0;
        for (let i = 0; i < results.length; i++) {
          const file = files[i];
          const meta = partsMetadata[i] || {};
          const result = results[i];
          let partDuration = 0;
          let partOk = false;
          if (result.status === 'fulfilled') {
            const { segments, durationMs } = result.value;
            partDuration = Math.max(Number(meta.durationMs) || 0, durationMs);
            partOk = true;
            // Apply offset à chaque segment
            for (const s of segments) {
              const startMs = Math.round(Number(s.start || 0) * 1000) + cumulativeOffsetMs;
              const endMs = Math.round(Number(s.end || 0) * 1000) + cumulativeOffsetMs;
              allSegments.push({ start: startMs / 1000, end: endMs / 1000, text: String(s.text || '').trim() });
            }
          } else {
            // Part fail : on garde le slot vide (passages dans cette plage seront absents),
            // mais on AVANCE cumulativeOffsetMs avec la durée client metadata pour que
            // les parts suivantes restent calées sur la vidéo finale.
            partDuration = Number(meta.durationMs) || 0;
          }
          // R2 upload result (parallèle, indépendant de la transcription).
          const upload = uploads[i];
          const r2Key = (upload.status === 'fulfilled' && upload.value.ok) ? upload.value.key : null;
          const mimeType = file.type;
          partsForKV.push({
            filename: String(file.name || ''),
            durationMs: partDuration,
            offsetMs: cumulativeOffsetMs,
            status: partOk ? 'ok' : 'failed',
            error: partOk ? null : (result.reason?.message || 'failed'),
            r2Key,
            mimeType,
          });
          cumulativeOffsetMs += partDuration;
        }
        const totalDurationMs = cumulativeOffsetMs;

        // 4) Analyze with Claude (segments unifiés, timestamps = position vidéo finale)
        emit({ step: 'analyzing', segmentsCount: allSegments.length, totalDurationMs });
        const transcriptWithTs = segmentsToTranscript(allSegments);
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

        // 5) Save KV — record enrichi avec parts[] (multi-file metadata)
        const id = recordId;
        const record = {
          id,
          title,
          originalFilename: partsForKV[0]?.filename || '',
          mimeType: files[0].type,
          sizeBytes: files.reduce((acc, f) => acc + (f.size || 0), 0),
          audioDurationMs: totalDurationMs,    // alias historique (= totalDurationMs)
          totalDurationMs,
          parts: partsForKV,
          passages,
          segmentsCount: allSegments.length,
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

        emit({ step: 'done', id, title, passages, audioDurationMs: totalDurationMs, totalDurationMs, parts: partsForKV });
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
