// ─── REGISTRE DES ÉLÈVES ─────────────────────────────────────────
const STUDENT_REGISTRY = {
  japhet: { id: "japhet", nom: "Japhet", programme: "Piano Master", statut: "actif", docId: "19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM" },
  messon: { id: "messon", nom: "Messon", programme: "Piano Master", statut: "actif", docId: "1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI" },
  dexter: { id: "dexter", nom: "Dexter", programme: "Piano Master", statut: "actif", docId: "1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A" },
  tara:   { id: "tara",   nom: "Tara",   programme: "Piano Master", statut: "actif", docId: "1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY" },
};

// Champs saisis manuellement → jamais écrasés par un re-sync LLM
const PROTECTED_FIELDS = [
  'premier_cours', 'fin_prevue', 'statut', 'programme', 'notes', 'manualDates',
];

// ─── CORS ────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── HELPERS ─────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function requireAuth(request, env) {
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  return null;
}

// ─── LLM providers (Gemini → Groq fallback) ──────────────────────
function isRetryableError(error) {
  const msg = String(error?.message || '');
  return /\b(429|500|502|503|504|UNAVAILABLE|timeout|network|fetch failed)\b/i.test(msg);
}

async function callGemini(prompt, apiKey, { maxTokens = 4096, temperature = 0.2 } = {}) {
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

async function callGroq(prompt, apiKey, { maxTokens = 4096, temperature = 0.2 } = {}) {
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

async function callLLM(prompt, env, opts) {
  // 1. Gemini first
  try {
    return await callGemini(prompt, env.GEMINI_API_KEY, opts);
  } catch (e) {
    console.log('[callLLM] Gemini failed:', e.message);
    // Non-retryable (4xx autres que 429) → propagation immédiate
    if (!isRetryableError(e)) throw e;
  }
  // 2. Groq fallback
  try {
    return await callGroq(prompt, env.GROQ_API_KEY, opts);
  } catch (e) {
    console.log('[callLLM] Groq failed:', e.message);
    throw e; // Caller décide (cache stale vs 503)
  }
}

function extractJSON(text) {
  let s = String(text).trim();
  // Strip ```json fences
  s = s.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;
  // Fallback : balanced first-to-last { ... }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

// ─── PARSING via LLM ─────────────────────────────────────────────
async function parseDoc(docText, student, env) {
  const systemPrompt = `Tu es un assistant qui extrait des données structurées depuis des notes de cours de piano.
Retourne UNIQUEMENT un objet JSON valide, sans markdown, sans backticks, sans commentaires.

Structure JSON exacte attendue :
{
  "id": "string",
  "nom": "string",
  "programme": "string",
  "statut": "actif",
  "premier_cours": "string — date exacte du tout premier cours au format JJ/MM/YYYY (ex: 15/02/2025)",
  "fin_prevue": "string — date du premier cours + 2 mois au format JJ/MM/YYYY (ex: 15/04/2025)",
  "frequence": "1× / semaine",
  "progression": number entre 0 et 100,
  "canaux": {
    "telegram": { "url": "string ou null", "handle": "string" },
    "discord":  { "url": "string ou null", "handle": "string" },
    "bonzai":   { "url": "string ou null", "handle": "string" }
  },
  "doc_url": "string",
  "theorie": [ { "label": "string", "statut": "done|in-progress|todo" } ],
  "repertoire": [ { "titre": "string", "compositeur": "string", "statut": "en-cours|acquis", "note": "string", "youtube": "url ou null" } ],
  "seances": [ { "date": "string", "focus": "string", "contenu": ["string"], "devoirs": ["string"] } ]
}

Règles :
- Estime la progression (0-100) : 0-20 = débuts, 20-40 = bases acquises, 40-60 = intermédiaire, 60+ = avancé
- Séances triées chronologiquement, plus ancienne en premier
- Normalise les notions théoriques (posture, intervalles, gammes, degrés, accords, renversements, ear training, arpèges, rythmique...)
- Marque "done" les notions clairement enseignées, "in-progress" celles en cours, "todo" les notions pas encore abordées
- Pour les canaux absents du doc : url = null, handle = ""
- premier_cours : cherche la date du tout premier cours mentionné dans le document. Format JJ/MM/YYYY.
- fin_prevue : calcule la date du premier cours + 2 mois exactement. Format JJ/MM/YYYY.
- Identifie les morceaux travaillés pour le répertoire (Let it be, Hallelujah, Stay With Me, etc.)
- Pour le répertoire : cherche les liens YouTube mentionnés dans le doc pour chaque morceau et mets-les dans le champ youtube. Si pas de lien trouvé, youtube = null.
- Résume contenu et devoirs en bullets courts et clairs (max 8 mots par bullet)`;

  const userPrompt = `Élève : ${student.nom} — Programme : ${student.programme}
ID : ${student.id}
Doc URL : https://docs.google.com/document/d/${student.docId}/edit

Notes de cours :
---
${docText.slice(0, 6000)}
---`;

  const text = await callLLM(`${systemPrompt}\n\n${userPrompt}`, env);
  const clean = extractJSON(text);
  const parsed = JSON.parse(clean);
  parsed.id = student.id;
  parsed.doc_url = `https://docs.google.com/document/d/${student.docId}/edit`;
  return parsed;
}

// ─── GET /api/eleves/{id} ────────────────────────────────────────
// Flux :
//  1. Cache KV présent + pas de ?sync=true       → { ...data, source: 'fresh' }
//  2. Cache absent ou ?sync=true :
//     a. Gemini OK                                → put KV + { ...data, source: 'fresh' }
//     b. Gemini fail → Groq OK                    → put KV + { ...data, source: 'fresh' }
//     c. Tous fail + cache existe                 → { ...cached, source: 'stale', error: 'LLM unavailable' }
//     d. Tous fail + pas de cache                 → 503
export async function onRequestGet({ params, request, env }) {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const id = params.id;
  const url = new URL(request.url);
  const forceSync = url.searchParams.get('sync') === 'true';

  const student = STUDENT_REGISTRY[id];
  if (!student) return jsonResponse({ error: 'Élève introuvable' }, 404);

  const cacheKey = `eleve:${id}`;
  const cachedRaw = await env.MASTERHUB_STUDENTS.get(cacheKey, { type: 'text' });
  const cached = cachedRaw ? JSON.parse(cachedRaw) : null;

  // 1. Cache frais (TTL KV géré nativement)
  if (cached && !forceSync) {
    return jsonResponse({ ...cached, source: 'fresh' });
  }

  // 2. Fetch Google Doc
  let docText;
  try {
    const docRes = await fetch(`https://docs.google.com/document/d/${student.docId}/export?format=txt`);
    if (!docRes.ok) throw new Error(`HTTP ${docRes.status}`);
    docText = await docRes.text();
  } catch (e) {
    if (cached) {
      return jsonResponse({ ...cached, source: 'stale', error: `Doc fetch failed: ${e.message}` });
    }
    return jsonResponse({
      error: "Impossible d'accéder au Google Doc. Vérifie que le partage est activé (lecture — quiconque avec le lien).",
      details: e.message,
    }, 502);
  }

  // 3. Parsing via LLM chain (Gemini → Groq)
  let parsed;
  try {
    parsed = await parseDoc(docText, student, env);
  } catch (e) {
    if (cached) {
      return jsonResponse({ ...cached, source: 'stale', error: 'LLM unavailable', details: e.message });
    }
    return jsonResponse({
      error: 'All LLM providers failed and no cache available',
      details: e.message,
    }, 503);
  }

  // 4. Merge PROTECTED_FIELDS depuis le cache existant
  if (cached) {
    for (const field of PROTECTED_FIELDS) {
      if (cached[field] !== undefined) {
        parsed[field] = cached[field];
      }
    }
  }

  parsed._cachedAt = Date.now();
  try {
    await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 3600 });
  } catch (_) {}

  return jsonResponse({ ...parsed, source: 'fresh' });
}

// ─── PATCH /api/eleves/{id} ──────────────────────────────────────
export async function onRequestPatch({ params, request, env }) {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const id = params.id;
  if (!STUDENT_REGISTRY[id]) return jsonResponse({ error: 'Élève introuvable' }, 404);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }

  const cacheKey = `eleve:${id}`;
  const existingRaw = await env.MASTERHUB_STUDENTS.get(cacheKey);
  if (!existingRaw) return jsonResponse({ error: 'Cache introuvable — lancer un sync' }, 404);

  const existing = JSON.parse(existingRaw);
  const updated = { ...existing, ...body };

  if (body.premier_cours !== undefined || body.fin_prevue !== undefined) {
    const parseDate = (str) => {
      if (!str) return null;
      const p = str.split('/');
      if (p.length !== 3) return null;
      return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
    };
    const start = parseDate(updated.premier_cours);
    const end = parseDate(updated.fin_prevue);
    const today = new Date();
    if (start && end && !isNaN(start) && !isNaN(end)) {
      const totalDays = (end - start) / (1000 * 60 * 60 * 24);
      if (totalDays > 0) {
        const elapsedDays = (today - start) / (1000 * 60 * 60 * 24);
        updated.progression = Math.min(
          100,
          Math.max(0, Math.round((elapsedDays / totalDays) * 100))
        );
      }
    }
  }

  await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(updated), { expirationTtl: 3600 });

  return jsonResponse({ success: true, data: updated });
}
