// ─── REGISTRE DES ÉLÈVES ─────────────────────────────────────────
// Source primaire : KV (`eleves:list` + `eleve:<slug>.doc_id`).
// FALLBACK_REGISTRY ne sert qu'en dégradation gracieuse (KV down ou clé
// `eleves:list` absente avant le bootstrap GET /api/eleves).
const FALLBACK_REGISTRY = {
  japhet: { id: "japhet", nom: "Japhet", programme: "Piano Master", statut: "actif", docId: "19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM" },
  messon: { id: "messon", nom: "Messon", programme: "Piano Master", statut: "actif", docId: "1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI" },
  dexter: { id: "dexter", nom: "Dexter", programme: "Piano Master", statut: "actif", docId: "1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A" },
  tara:   { id: "tara",   nom: "Tara",   programme: "Piano Master", statut: "actif", docId: "1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY" },
};

async function resolveStudent(id, env) {
  // 1. Membership : `eleves:list` (KV) → fallback clés FALLBACK_REGISTRY
  let validSlugs;
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    validSlugs = Array.isArray(list) && list.length ? list : Object.keys(FALLBACK_REGISTRY);
  } catch {
    validSlugs = Object.keys(FALLBACK_REGISTRY);
  }
  if (!validSlugs.includes(id)) return null;

  // 2. doc_id : `eleve:<id>.doc_id` (KV) → fallback FALLBACK_REGISTRY[id].docId
  let cached = null;
  try {
    cached = await env.MASTERHUB_STUDENTS.get(`eleve:${id}`, { type: 'json' });
  } catch { /* fallback ci-dessous */ }
  const fb = FALLBACK_REGISTRY[id] || {};
  const docId = cached?.doc_id || fb.docId;
  if (!docId) return null;

  return {
    id,
    nom: cached?.nom || fb.nom || (id.charAt(0).toUpperCase() + id.slice(1)),
    programme: cached?.programme || fb.programme || 'Piano Master',
    statut: cached?.statut || fb.statut || 'actif',
    docId,
  };
}

// Champs saisis manuellement OU calculés par sync.js → jamais écrasés par un re-sync LLM
// (parseDoc ne renvoie que des champs LLM bruts, sans stats ni override)
const PROTECTED_FIELDS = [
  'premier_cours',
  'fin_prevue',
  'statut',
  'programme',
  'notes',
  'manualDates',
  // Ajouts persistance KV : stats + overrides utilisateur + dernière séance + doc_id
  'stats',
  'stats_override',
  'stats_auto_raw',
  'derniere_seance',
  'doc_id',
  'doc_url',
  'canaux',
  'email',
  '_patchedAt',
];

// ─── CORS ────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── HELPERS ─────────────────────────────────────────────────────
import { requireAdmin } from '../_lib/session.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function requireAuth(request, env) {
  if (!(await requireAdmin(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
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

// extractJSON, mergeStats, parseIsoDate, labelFr, computeProgressionPct
// sont importés de _lib/ (C6+D2 dedup avec sync.js).
import { extractJSON } from '../_lib/json-extract.js';
import { mergeStats, parseIsoDate } from '../_lib/eleves-stats.js';

// ─── Sanitization post-LLM des années (anti-hallucination) ───────
// Le LLM peut produire "08/03/2024" sur un doc qui ne dit que "08/03". On corrige
// toute date au format JJ/MM/YYYY dont l'année est < (currentYear - 1) — c'est
// presque toujours une hallucination biaisée par les exemples du prompt.
function sanitizeYears(parsed, currentYear) {
  const cutoffYear = currentYear - 1;

  function fixDate(dateStr, label) {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return dateStr;
    const year = parseInt(m[3], 10);
    if (year < cutoffYear) {
      const corrected = `${m[1]}/${m[2]}/${currentYear}`;
      console.warn(`[parseDoc] year sanitized (${label}): "${dateStr}" → "${corrected}"`);
      return corrected;
    }
    return dateStr;
  }

  if (parsed.premier_cours) parsed.premier_cours = fixDate(parsed.premier_cours, 'premier_cours');
  if (parsed.fin_prevue)    parsed.fin_prevue    = fixDate(parsed.fin_prevue, 'fin_prevue');
  if (Array.isArray(parsed.seances)) {
    parsed.seances = parsed.seances.map((s, i) => ({
      ...s,
      date: fixDate(s.date, `seances[${i}]`),
    }));
  }
  return parsed;
}

// ─── Schema validation post-LLM (B5) ────────────────────────────
// Vérifie sanity du profil élève retourné par parseDoc. Si le LLM hallucine
// la structure (ex: theorie en string au lieu d'array), throw → catch upstream
// → fallback cache stale (L342) ou 503 si pas de cache.
function validateParsedProfile(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parsed: not an object');
  }
  if (typeof parsed.nom !== 'string' || !parsed.nom.trim()) {
    throw new Error('parsed.nom: missing or invalid (expected non-empty string)');
  }
  if (typeof parsed.programme !== 'string' || !parsed.programme.trim()) {
    throw new Error('parsed.programme: missing or invalid (expected non-empty string)');
  }
  if (parsed.theorie != null && !Array.isArray(parsed.theorie)) {
    throw new Error('parsed.theorie: expected array, got ' + typeof parsed.theorie);
  }
  if (parsed.repertoire != null && !Array.isArray(parsed.repertoire)) {
    throw new Error('parsed.repertoire: expected array, got ' + typeof parsed.repertoire);
  }
  if (parsed.seances != null && !Array.isArray(parsed.seances)) {
    throw new Error('parsed.seances: expected array, got ' + typeof parsed.seances);
  }
  return parsed;
}

// ─── PARSING via LLM ─────────────────────────────────────────────
async function parseDoc(docText, student, env) {
  const currentYear = new Date().getFullYear();
  const exDebut = `15/02/${currentYear}`;
  const exFin   = `15/04/${currentYear}`;

  const systemPrompt = `Tu es un assistant qui extrait des données structurées depuis des notes de cours de piano.
Retourne UNIQUEMENT un objet JSON valide, sans markdown, sans backticks, sans commentaires.

Structure JSON exacte attendue :
{
  "id": "string",
  "nom": "string",
  "programme": "string",
  "statut": "actif",
  "premier_cours": "string — date exacte du tout premier cours au format JJ/MM/YYYY (ex: ${exDebut})",
  "fin_prevue": "string — date du premier cours + 2 mois au format JJ/MM/YYYY (ex: ${exFin})",
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

REGLES DATES (CRITIQUES — l'année courante est ${currentYear}) :
- Si une date est écrite au format "JJ/MM" sans année (ex: "08/03", "16/03"), tu DOIS utiliser l'année ${currentYear}. Résultat : "08/03/${currentYear}".
- Si une date est écrite au format "JJ/MM/AA" (ex: "08/03/26", "08/03/${String(currentYear).slice(-2)}"), tu DOIS interpréter "AA" comme "20AA". Résultat : "08/03/20AA".
- Si l'année produite est antérieure à ${currentYear - 1} ET le programme est actif, c'est une faute de frappe — utilise ${currentYear}.
- N'INVENTE JAMAIS d'année. En cas de doute, prends ${currentYear}.
- Pour les séances déjà passées (date < aujourd'hui), même règle : année courante par défaut, sauf mention explicite contraire dans le doc.

Autres règles :
- Estime la progression (0-100) : 0-20 = débuts, 20-40 = bases acquises, 40-60 = intermédiaire, 60+ = avancé
- Séances triées chronologiquement, plus ancienne en premier
- Normalise les notions théoriques (posture, intervalles, gammes, degrés, accords, renversements, ear training, arpèges, rythmique...)
- Marque "done" les notions clairement enseignées, "in-progress" celles en cours, "todo" les notions pas encore abordées
- Pour les canaux absents du doc : url = null, handle = ""
- premier_cours : cherche la date du tout premier cours mentionné dans le document. Format JJ/MM/YYYY (applique les REGLES DATES ci-dessus).
- fin_prevue : calcule la date du premier cours + 2 mois exactement. Format JJ/MM/YYYY (applique les REGLES DATES ci-dessus).
- Identifie les morceaux travaillés pour le répertoire (Let it be, Hallelujah, Stay With Me, etc.)
- Pour le répertoire : cherche les liens YouTube mentionnés dans le doc pour chaque morceau et mets-les dans le champ youtube. Si pas de lien trouvé, youtube = null.
- Résume contenu et devoirs en bullets courts et clairs (max 8 mots par bullet)`;

  const userPrompt = `Élève : ${student.nom} — Programme : ${student.programme}
ID : ${student.id}
Doc URL : https://docs.google.com/document/d/${student.docId}/edit
Année courante : ${currentYear}

Notes de cours :
---
${docText.slice(0, 6000)}
---`;

  const text = await callLLM(`${systemPrompt}\n\n${userPrompt}`, env);
  // extractJSON (3-level robust, _lib) retourne directement l'objet parsé
  let parsed;
  try {
    parsed = extractJSON(text);
  } catch (e) {
    console.error('[parseDoc] JSON parse failed:', e?.message || e, 'raw_first200:', String(text).slice(0, 200));
    throw new Error('parseDoc: JSON parse failed (' + (e?.message || 'unknown') + ')');
  }
  // Schema validation post-LLM (B5) — throw si structure cassée → cache stale préservé
  try {
    validateParsedProfile(parsed);
  } catch (e) {
    console.error('[parseDoc] schema validation failed:', e.message, 'raw_first200:', String(text).slice(0, 200));
    throw e;
  }
  // Garde-fou : corrige les dates dont le LLM aurait inventé une année trop ancienne
  sanitizeYears(parsed, currentYear);
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
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;

  const id = params.id;
  const url = new URL(request.url);
  const forceSync = url.searchParams.get('sync') === 'true';

  const student = await resolveStudent(id, env);
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
  // Pas de TTL : les données élèves doivent persister indéfiniment.
  // La fraîcheur est gérée applicativement (forceSync=true ou _cachedAt explicite).
  try {
    await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(parsed));
  } catch (e) {
    console.error('[eleves/[id]] KV put failed:', e?.message || e, 'key:', cacheKey);
  }

  return jsonResponse({ ...parsed, source: 'fresh' });
}

// ─── PATCH /api/eleves/{id} ──────────────────────────────────────
// Body : { stats_override: { date_debut?: "YYYY-MM-DD"|null, date_fin?: "YYYY-MM-DD"|null, total_cours?: int|null } }
// - Champs présents dans body.stats_override sont mergés avec l'override existant.
// - Valeur null = supprime le champ d'override (revient au calcul auto/défaut).
// - date_debut/date_fin : ISO YYYY-MM-DD uniquement.
// - total_cours : entier 1..100.
// - Recompute `stats` via mergeStats(stats_auto_raw, nouvel override).
const ALLOWED_OVERRIDE_FIELDS = ['date_debut', 'date_fin', 'total_cours'];

export async function onRequestPatch({ params, request, env }) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;

  const id = params.id;
  const exists = await resolveStudent(id, env);
  if (!exists) return jsonResponse({ error: 'Élève introuvable' }, 404);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }

  const cacheKey = `eleve:${id}`;
  const existingRaw = await env.MASTERHUB_STUDENTS.get(cacheKey);
  if (!existingRaw) return jsonResponse({ error: 'Cache introuvable — lancer un sync' }, 404);

  const existing = JSON.parse(existingRaw);
  const updated = { ...existing };

  // ── Validation helpers ────────────────────────────────────────
  const isValidIsoOrNull = (v) => {
    if (v === null) return true;
    if (typeof v !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    return parseIsoDate(v) !== null;
  };
  const isValidTotalCoursOrNull = (v) => {
    if (v === null) return true;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 100;
  };

  // ── Handle stats_override patch ────────────────────────────────
  if (body.stats_override !== undefined) {
    const patch = body.stats_override || {};

    if (patch.date_debut !== undefined && !isValidIsoOrNull(patch.date_debut)) {
      return jsonResponse({ error: 'stats_override.date_debut invalide (YYYY-MM-DD ou null)' }, 400);
    }
    if (patch.date_fin !== undefined && !isValidIsoOrNull(patch.date_fin)) {
      return jsonResponse({ error: 'stats_override.date_fin invalide (YYYY-MM-DD ou null)' }, 400);
    }
    if (patch.total_cours !== undefined && !isValidTotalCoursOrNull(patch.total_cours)) {
      return jsonResponse({ error: 'stats_override.total_cours invalide (entier 1..100 ou null)' }, 400);
    }

    // Merge : null → delete (revient à l'auto). Sinon écrase.
    const newOverride = { ...(existing.stats_override || {}) };
    for (const f of ALLOWED_OVERRIDE_FIELDS) {
      if (patch[f] === undefined) continue;
      if (patch[f] === null) {
        delete newOverride[f];
      } else {
        newOverride[f] = (f === 'total_cours') ? Number(patch[f]) : patch[f];
      }
    }

    updated.stats_override = newOverride;
    const autoRaw = existing.stats_auto_raw || { nb_cours: 0, date_debut: null, date_fin_prevue: null };
    const stats = mergeStats(autoRaw, newOverride);
    updated.stats = stats;
    updated.sessionCount = stats.nb_cours;
    updated.progression = stats.progression_pct;
  }

  // ── Handle doc_id patch (admin édite l'URL Google Doc) ──────
  // body.doc_id = string (ID Google Doc) | null | '' (pour supprimer le lien)
  if (body.doc_id !== undefined) {
    if (body.doc_id === null || body.doc_id === '') {
      delete updated.doc_id;
      delete updated.doc_url;
    } else if (typeof body.doc_id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(body.doc_id)) {
      return jsonResponse({ error: 'doc_id invalide (attendu : ID Google Doc, ex 1AbCdEf...)' }, 400);
    } else {
      updated.doc_id = body.doc_id;
      updated.doc_url = `https://docs.google.com/document/d/${body.doc_id}/edit`;
    }
  }

  // ── Handle canaux partial merge (telegram/discord/bonzai) ────
  // body.canaux = { telegram?: { url?, handle? }|null, discord?: ..., bonzai?: ... }
  // url = '' ou null → vide le lien (handle préservé sauf override)
  if (body.canaux !== undefined) {
    if (!body.canaux || typeof body.canaux !== 'object' || Array.isArray(body.canaux)) {
      return jsonResponse({ error: 'canaux invalide (attendu : objet)' }, 400);
    }
    const existingCanaux = (existing.canaux && typeof existing.canaux === 'object') ? existing.canaux : {};
    const merged = { ...existingCanaux };
    for (const channel of ['telegram', 'discord', 'bonzai']) {
      const patch = body.canaux[channel];
      if (patch === undefined) continue;
      if (patch === null) { delete merged[channel]; continue; }
      if (typeof patch !== 'object' || Array.isArray(patch)) {
        return jsonResponse({ error: `canaux.${channel} invalide` }, 400);
      }
      if (patch.url !== undefined && patch.url !== null && patch.url !== '') {
        if (typeof patch.url !== 'string' || !/^https?:\/\//i.test(patch.url)) {
          return jsonResponse({ error: `canaux.${channel}.url invalide (attendu : https://...)` }, 400);
        }
      }
      const next = { ...(existingCanaux[channel] || {}), ...patch };
      if (patch.url === '' || patch.url === null) next.url = null;
      merged[channel] = next;
    }
    updated.canaux = merged;
  }

  // ── Handle email patch (admin saisit l'email pour le magic link) ─
  // body.email = string | null | '' (pour supprimer)
  // Maintient l'index inverse `email:<email_lowercase>` → { slug } pour
  // permettre au request-link de faire un lookup O(1) (cf api/auth/request-link.js).
  let emailIndexOld = null;
  let emailIndexNew = null;
  if (body.email !== undefined) {
    const oldEmail = typeof existing.email === 'string' ? existing.email.toLowerCase() : null;
    if (body.email === null || body.email === '') {
      delete updated.email;
      if (oldEmail) emailIndexOld = oldEmail;
    } else if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      return jsonResponse({ error: 'email invalide' }, 400);
    } else {
      const newEmail = String(body.email).trim().toLowerCase();
      updated.email = newEmail;
      if (oldEmail && oldEmail !== newEmail) emailIndexOld = oldEmail;
      emailIndexNew = newEmail;
    }
  }

  // ── Backwards-compat : permet PATCH de champs libres (notes, statut, programme) ──
  const ALLOW_FIELDS = ['notes', 'statut', 'programme'];
  for (const f of ALLOW_FIELDS) {
    if (body[f] !== undefined) updated[f] = body[f];
  }

  updated._patchedAt = new Date().toISOString();
  // Pas de TTL : un override saisi manuellement doit persister jusqu'au prochain reset explicite.
  await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(updated));

  // Maintient l'index inverse email:<email> APRÈS l'écriture du profil. Erreurs
  // non-bloquantes : le profil est sauvegardé même si l'index échoue (le
  // fallback scan dans request-link couvre ce cas).
  if (emailIndexOld) {
    try { await env.MASTERHUB_STUDENTS.delete(`email:${emailIndexOld}`); }
    catch (e) { console.warn('[eleves/PATCH] email index delete failed:', e?.message || e); }
  }
  if (emailIndexNew) {
    try { await env.MASTERHUB_STUDENTS.put(`email:${emailIndexNew}`, JSON.stringify({ slug: id })); }
    catch (e) { console.warn('[eleves/PATCH] email index put failed:', e?.message || e); }
  }

  return jsonResponse({ ok: true, success: true, data: updated, stats: updated.stats || null });
}
