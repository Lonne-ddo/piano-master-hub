// ─── Sync élèves depuis Google Docs ──────────────────────────────
// POST /api/eleves/sync — pour chaque élève :
//  1. Fetch Google Doc (export plain text)
//  2. 1 appel LLM (Gemini 2.5 Flash → Groq Llama 3.3 fallback)
//     qui extrait uniquement la DERNIÈRE SÉANCE sous forme
//     { date, titre, devoirs[], resume[] }
//  3. Merge avec KV existant (préserve theorie/progression/canaux/repertoire
//     injectés par [id].js + PROTECTED_FIELDS pour les éditions manuelles)
//  4. En cas d'échec LLM : cache KV préservé, élève listé dans llmFailed
// Auth : header x-admin-secret requis.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const DOCS = {
  japhet: '19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM',
  messon: '1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI',
  dexter: '1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A',
  tara:   '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY',
};

// Champs jamais écrasés par un re-sync (éditions manuelles via PATCH)
const PROTECTED_FIELDS = [
  'premier_cours', 'fin_prevue', 'statut', 'programme', 'notes', 'manualDates',
];

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── LLM providers (Gemini → Groq fallback) ──────────────────────
function isRetryableError(error) {
  const msg = String(error?.message || '');
  return /\b(429|500|502|503|504|UNAVAILABLE|timeout|network|fetch failed)\b/i.test(msg);
}

async function callGemini(prompt, apiKey, { maxTokens = 1500, temperature = 0.2 } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante');
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: réponse vide');
  return text;
}

async function callGroq(prompt, apiKey, { maxTokens = 1500, temperature = 0.2 } = {}) {
  if (!apiKey) throw new Error('GROQ_API_KEY manquante');
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Groq HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq: réponse vide');
  return text;
}

async function callLLM(prompt, env, opts, eleveId) {
  // Gemini primary
  try {
    console.log(`[sync.js] eleve=${eleveId} llm=gemini-2.5-flash attempt=1`);
    return { text: await callGemini(prompt, env.GEMINI_API_KEY, opts), provider: 'gemini-2.5-flash' };
  } catch (e) {
    console.log(`[sync.js] eleve=${eleveId} gemini_failed: ${e.message}`);
    if (!isRetryableError(e)) throw e;
  }
  // Groq fallback
  console.log(`[sync.js] eleve=${eleveId} llm=llama-3.3-70b-versatile attempt=2`);
  return { text: await callGroq(prompt, env.GROQ_API_KEY, opts), provider: 'groq-llama-3.3' };
}

// Robust JSON extraction : strip ```json fences, fallback to balanced {...},
// final sanitization (retire trailing commas)
function extractJSON(text) {
  let s = String(text || '').trim();
  // 1. Strip markdown fences
  s = s.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  // 2. If balanced {...}, return as-is
  if (s.startsWith('{') && s.endsWith('}')) return sanitize(s);
  // 3. Fallback : first '{' to last '}'
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return sanitize(s.slice(first, last + 1));
  return s;
}

function sanitize(s) {
  // Retire trailing commas (courant avec Groq)
  return s.replace(/,(\s*[\]}])/g, '$1');
}

function safeJsonParse(text) {
  // Tente parse direct, puis avec sanitization supplémentaire si échec
  try { return JSON.parse(text); } catch (_) {}
  try { return JSON.parse(sanitize(text)); } catch (_) {}
  throw new Error('JSON parse failed after sanitization');
}

// ─── Extraction : dernière séance uniquement ─────────────────────
async function extractLatestSession(docText, eleveId, studentName, env) {
  const currentYear = new Date().getFullYear();
  const prompt = `Tu es un extracteur structuré pour les docs Google de suivi d'élèves de piano. Le doc contient un historique de séances séparées par des titres "# DD/MM" ou "# DD/MM/YYYY". Chaque séance peut être formatée différemment : Markdown gras (**Notions enseignées**), émoji + bullets (🎹 résumé du cours :), ou texte libre (A faire :).

Ta tâche : identifier la SÉANCE LA PLUS RÉCENTE et en extraire :
- date (au format YYYY-MM-DD si l'année est explicite dans le doc, sinon YYYY = année courante ${currentYear})
- titre court (1-3 mots qui résument le thème principal)
- devoirs (array de 3-8 strings concis et actionnables)
- resume (array de 5-8 strings synthétisant les notions enseignées + conseils donnés, fusionnés)

RÈGLES :
- Reformule de façon SYNTHÉTIQUE (max 12 mots par bullet)
- Fusionne notions + conseils dans "resume" (pas de doublon)
- Dans "devoirs" : reformule en impératif court
- IGNORE les sections "Observations sur l'élève" — elles ne doivent PAS apparaître dans le JSON (ce sont des notes privées coach)
- IGNORE l'organisation générale, les accès Telegram/Bonzai/Discord
- Si la dernière séance n'a pas de devoirs explicites, devoirs = []
- Si tu vois plusieurs formats dans le même doc, prends quand même UNIQUEMENT la séance la plus récente (date la plus haute)
- Préserve la terminologie musicale exacte (Maj7, min7, Cmaj7, voicings, gammes relatives, etc.)

FORMAT JSON STRICT — AUCUN TEXTE HORS JSON :
{
  "date": "${currentYear}-04-22",
  "titre": "accords enrichis",
  "devoirs": ["...", "..."],
  "resume": ["...", "..."]
}

Élève : ${studentName}

Contenu du doc :
---
${docText.slice(0, 12000)}
---`;

  const { text } = await callLLM(prompt, env, { maxTokens: 1500, temperature: 0.2 }, eleveId);
  const clean = extractJSON(text);
  return safeJsonParse(clean);
}

// ─── POST /api/eleves/sync ───────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const results = {};
  const llmFailed = [];

  for (const [name, docId] of Object.entries(DOCS)) {
    const startMs = Date.now();
    try {
      // 1. Fetch doc
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const res = await fetch(exportUrl);
      if (!res.ok) {
        results[name] = { error: `HTTP ${res.status}` };
        console.log(`[sync.js] eleve=${name} step=doc_fetch status=${res.status}`);
        continue;
      }
      const docText = await res.text();

      // 2. LLM extraction (Gemini → Groq fallback)
      let derniere_seance;
      try {
        derniere_seance = await extractLatestSession(docText, name, capitalize(name), env);
      } catch (llmErr) {
        llmFailed.push(name);
        results[name] = { error: `LLM unavailable: ${llmErr.message}` };
        console.log(`[sync.js] eleve=${name} step=llm status=failed duration=${Date.now()-startMs}ms error=${llmErr.message}`);
        continue;
      }

      // 3. Merge avec KV existant (préserve fields de [id].js + PROTECTED_FIELDS)
      const cacheKey = `eleve:${name}`;
      const existing = await env.MASTERHUB_STUDENTS.get(cacheKey, { type: 'json' }) || {};
      const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

      const updated = {
        // Préserve tout ce qui existe (theorie, progression, canaux, repertoire, etc.)
        ...existing,
        // Override avec les champs canoniques (une seule fois chacun)
        id: name,
        nom: capitalize(name),
        doc_id: docId,
        doc_url: docUrl,
        derniere_seance,
        _syncedAt: new Date().toISOString(),
        _cachedAt: Date.now(),
      };

      // PROTECTED_FIELDS : préserver les éditions manuelles au-dessus de tout
      for (const field of PROTECTED_FIELDS) {
        if (existing[field] !== undefined) {
          updated[field] = existing[field];
        }
      }

      await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(updated), { expirationTtl: 3600 });
      results[name] = { ok: true, date: derniere_seance?.date, titre: derniere_seance?.titre };
      console.log(`[sync.js] eleve=${name} step=done status=ok duration=${Date.now()-startMs}ms date=${derniere_seance?.date}`);

    } catch (e) {
      results[name] = { error: e.message };
      console.log(`[sync.js] eleve=${name} unexpected_error=${e.message}`);
    }
  }

  if (llmFailed.length > 0) {
    return jsonResponse({
      ok: false,
      error: 'LLM unavailable for some students',
      failed: llmFailed,
      results,
    }, 503);
  }
  return jsonResponse({ ok: true, success: true, results });
}
