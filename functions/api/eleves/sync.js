// ─── Sync élèves depuis Google Docs ──────────────────────────────
// POST /api/eleves/sync — pour chaque élève :
//  1. Fetch Google Doc (export plain text)
//  2. Calcul stats globales par regex (nb_cours, date_debut, date_fin_prevue,
//     progression_pct) — indépendant du LLM
//  3. Cascade LLM avec mode JSON natif pour extraire `derniere_seance` :
//       Gemini 2.5 Flash (responseMimeType=application/json)
//     → Groq Llama 3.3 (response_format=json_object)
//     → Claude Sonnet 4.6 (si ANTHROPIC_API_KEY dispo, sinon skip)
//     → cache KV stale (si présent) ou 503 avec détails
//  4. Merge avec KV existant. Dates (premier_cours/fin_prevue) override par le
//     calcul regex SAUF si existing.manualDates === true (édition manuelle).
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

// Source primaire : KV (`eleves:list` + `eleve:<slug>.doc_id`).
// FALLBACK_DOCS ne sert qu'en dégradation gracieuse (KV down ou clés absentes
// avant le bootstrap GET /api/eleves + POST seed-doc-ids).
const FALLBACK_DOCS = {
  japhet: '19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM',
  messon: '1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI',
  dexter: '1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A',
  tara:   '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY',
};

async function loadDocsMap(env) {
  let slugs;
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    slugs = Array.isArray(list) && list.length ? list : Object.keys(FALLBACK_DOCS);
  } catch {
    slugs = Object.keys(FALLBACK_DOCS);
  }
  const out = {};
  for (const slug of slugs) {
    let cached = null;
    try {
      cached = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
    } catch { /* fallback ci-dessous */ }
    const docId = cached?.doc_id || FALLBACK_DOCS[slug];
    if (docId) out[slug] = docId;
  }
  return out;
}

// Champs préservés par le `...existing` spread lors du merge (statut, programme,
// notes, manualDates, theorie, progression calculée, canaux, repertoire, etc.).
// Les dates (premier_cours, fin_prevue) sont gérées séparément : override par le
// calcul regex SAUF si existing.manualDates === true (édition manuelle via PATCH).

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Stats : calcul auto via regex + override KV ─────────────────
// Matche les titres de séance : "# 08/03", "08/03", "22/04/2024", "## 8/3/24"
// Rejette : "Onglet 1", "Général", "PRATIQUE", "Tab 1" (pas au format JJ/MM)
const SESSION_TITLE_RE = /^[\s#]*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*$/gm;

// mergeStats, parseIsoDate, labelFr, computeProgressionPct importés de _lib/.
// extractJSON aussi (3-level robust shared avec [id].js).
import { mergeStats } from '../_lib/eleves-stats.js';
import { extractJSON } from '../_lib/json-extract.js';

// Helpers locaux à sync.js (utilisés par computeAutoStats uniquement)
function pad2(n) { return String(n).padStart(2, '0'); }
function isoOf(d) {
  if (!d || isNaN(d)) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseSessionTitles(docText) {
  const currentYear = new Date().getFullYear();
  const out = [];
  SESSION_TITLE_RE.lastIndex = 0;
  let m;
  while ((m = SESSION_TITLE_RE.exec(docText)) !== null) {
    const jour = parseInt(m[1], 10);
    const mois = parseInt(m[2], 10);
    let annee = m[3] ? parseInt(m[3], 10) : currentYear;
    if (annee < 100) annee += 2000; // "24" → 2024, "26" → 2026
    if (jour >= 1 && jour <= 31 && mois >= 1 && mois <= 12 && annee >= 2020 && annee <= 2100) {
      out.push({ jour, mois, annee });
    }
  }
  return out;
}

// Calcul auto brut : nb_cours + date_debut (ISO) + date_fin_prevue (ISO = début +60j)
function computeAutoStats(sessions) {
  if (!sessions.length) {
    return { nb_cours: 0, date_debut: null, date_fin_prevue: null };
  }
  const sorted = [...sessions].sort((a, b) => {
    if (a.annee !== b.annee) return a.annee - b.annee;
    if (a.mois !== b.mois) return a.mois - b.mois;
    return a.jour - b.jour;
  });
  const first = sorted[0];
  const start = new Date(first.annee, first.mois - 1, first.jour);
  const end = new Date(start);
  end.setDate(end.getDate() + 60);
  return {
    nb_cours: sessions.length,
    date_debut: isoOf(start),
    date_fin_prevue: isoOf(end),
  };
}

// mergeStats importé de _lib/eleves-stats.js (cf. import en tête de fichier).

// ─── Prompt ──────────────────────────────────────────────────────
// Séparé system/user car Gemini utilise systemInstruction et Groq utilise
// messages[role=system]. Le mot "JSON" apparaît plusieurs fois dans le
// system (requis par Groq avec response_format=json_object).
function buildPrompt(studentName) {
  const currentYear = new Date().getFullYear();
  const system = `Tu es un extracteur structuré pour les docs Google de suivi d'élèves de piano. Le doc contient un historique de séances séparées par des titres "# DD/MM" ou "# DD/MM/YYYY". Chaque séance peut être formatée différemment : Markdown gras (**Notions enseignées**), émoji + bullets (🎹 résumé du cours :), ou texte libre (A faire :).

Ta tâche : identifier la SÉANCE LA PLUS RÉCENTE et en extraire :
- date (au format YYYY-MM-DD si l'année est explicite dans le doc, sinon YYYY = année courante ${currentYear})
- titre court (1-3 mots qui résument le thème principal)
- devoirs (array de 3-8 strings concis et actionnables)
- resume (array de 5-8 strings synthétisant les notions enseignées + conseils donnés, fusionnés)

RÈGLES :
- Reformule de façon SYNTHÉTIQUE (max 12 mots par bullet)
- Fusionne notions + conseils dans "resume" (pas de doublon)
- Dans "devoirs" : reformule en impératif court
- IGNORE les sections "Observations sur l'élève" — elles ne doivent PAS apparaître dans le JSON (notes privées coach)
- IGNORE l'organisation générale, les accès Telegram/Bonzai/Discord
- Si la dernière séance n'a pas de devoirs explicites, devoirs = []
- Si tu vois plusieurs formats dans le même doc, prends quand même UNIQUEMENT la séance la plus récente (date la plus haute)
- Préserve la terminologie musicale exacte (Maj7, min7, Cmaj7, voicings, gammes relatives, etc.)

FORMAT JSON STRICT — Tu dois répondre UNIQUEMENT avec un objet JSON valide respectant cette structure exacte :
{
  "date": "${currentYear}-04-22",
  "titre": "accords enrichis",
  "devoirs": ["...", "..."],
  "resume": ["...", "..."]
}

AUCUN texte hors JSON. Pas de markdown, pas de backticks, pas d'explication.`;
  const buildUser = (docText) => `Élève : ${studentName}

Contenu du doc :
---
${docText.slice(0, 12000)}
---`;
  return { system, buildUser };
}

// ─── LLM providers (JSON natif forcé) ────────────────────────────
async function callGemini(systemPrompt, userMessage, apiKey, opts = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante');
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxTokens || 4000,
        },
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

async function callGroq(systemPrompt, userMessage, apiKey, opts = {}) {
  if (!apiKey) throw new Error('GROQ_API_KEY manquante');
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens || 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
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

async function callClaude(systemPrompt, userMessage, apiKey, opts = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: opts.maxTokens || 4000,
      temperature: opts.temperature ?? 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Claude: réponse vide');
  return text;
}

// extractJSON 3-level importé de _lib/json-extract.js (cf. import en tête de fichier).

// ─── Schema validation post-LLM (B5) ────────────────────────────
// Vérifie que le JSON extrait correspond bien à { date, titre, devoirs[], resume[] }.
// Si le LLM hallucine la structure, throw → catch upstream → cache existant préservé.
function validateParsedSeance(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parsed: not an object');
  }
  if (typeof parsed.date !== 'string' || !parsed.date.trim()) {
    throw new Error('parsed.date: missing or invalid (expected non-empty string)');
  }
  if (typeof parsed.titre !== 'string' || !parsed.titre.trim()) {
    throw new Error('parsed.titre: missing or invalid (expected non-empty string)');
  }
  if (!Array.isArray(parsed.devoirs)) {
    throw new Error('parsed.devoirs: expected array, got ' + typeof parsed.devoirs);
  }
  if (!Array.isArray(parsed.resume)) {
    throw new Error('parsed.resume: expected array, got ' + typeof parsed.resume);
  }
  return parsed;
}

// ─── Cascade LLM : Gemini → Groq → Claude ────────────────────────
async function extractLatestSession(docText, eleveId, studentName, env) {
  const { system, buildUser } = buildPrompt(studentName);
  const userMessage = buildUser(docText);
  const opts = { maxTokens: 4000, temperature: 0.2 };
  const tried = [];
  const errors = [];

  // Tentative 1 : Gemini (responseMimeType=application/json)
  if (env.GEMINI_API_KEY) {
    tried.push('gemini');
    const t0 = Date.now();
    let raw = null;
    try {
      console.log(`[sync.js] eleve=${eleveId} provider=gemini attempt=start`);
      raw = await callGemini(system, userMessage, env.GEMINI_API_KEY, opts);
      console.log(`[sync.js] eleve=${eleveId} provider=gemini raw_response_first200="${raw.slice(0, 200).replace(/\s+/g, ' ')}"`);
      const parsed = extractJSON(raw);
      validateParsedSeance(parsed);
      console.log(`[sync.js] eleve=${eleveId} provider=gemini parse=ok duration=${Date.now()-t0}ms`);
      return { parsed, provider: 'gemini-2.5-flash' };
    } catch (e) {
      const detail = raw ? ` raw_response_chars=${raw.length}` : '';
      console.error(`[sync.js] eleve=${eleveId} provider=gemini error="${e.message}"${detail} duration=${Date.now()-t0}ms`);
      errors.push({ provider: 'gemini', message: e.message, lastRaw: raw?.slice(0, 200) });
    }
  }

  // Tentative 2 : Groq (response_format=json_object)
  if (env.GROQ_API_KEY) {
    tried.push('groq');
    const t0 = Date.now();
    let raw = null;
    try {
      console.log(`[sync.js] eleve=${eleveId} provider=groq attempt=start`);
      raw = await callGroq(system, userMessage, env.GROQ_API_KEY, opts);
      console.log(`[sync.js] eleve=${eleveId} provider=groq raw_response_first200="${raw.slice(0, 200).replace(/\s+/g, ' ')}"`);
      const parsed = extractJSON(raw);
      validateParsedSeance(parsed);
      console.log(`[sync.js] eleve=${eleveId} provider=groq parse=ok duration=${Date.now()-t0}ms`);
      return { parsed, provider: 'groq-llama-3.3' };
    } catch (e) {
      const detail = raw ? ` raw_response_chars=${raw.length}` : '';
      console.error(`[sync.js] eleve=${eleveId} provider=groq error="${e.message}"${detail} duration=${Date.now()-t0}ms`);
      errors.push({ provider: 'groq', message: e.message, lastRaw: raw?.slice(0, 200) });
    }
  }

  // Tentative 3 : Claude Sonnet 4.6 (optionnel)
  if (env.ANTHROPIC_API_KEY) {
    tried.push('claude');
    const t0 = Date.now();
    let raw = null;
    try {
      console.log(`[sync.js] eleve=${eleveId} provider=claude attempt=start`);
      raw = await callClaude(system, userMessage, env.ANTHROPIC_API_KEY, opts);
      console.log(`[sync.js] eleve=${eleveId} provider=claude raw_response_first200="${raw.slice(0, 200).replace(/\s+/g, ' ')}"`);
      const parsed = extractJSON(raw);
      validateParsedSeance(parsed);
      console.log(`[sync.js] eleve=${eleveId} provider=claude parse=ok duration=${Date.now()-t0}ms`);
      return { parsed, provider: 'claude-sonnet-4-6' };
    } catch (e) {
      const detail = raw ? ` raw_response_chars=${raw.length}` : '';
      console.error(`[sync.js] eleve=${eleveId} provider=claude error="${e.message}"${detail} duration=${Date.now()-t0}ms`);
      errors.push({ provider: 'claude', message: e.message, lastRaw: raw?.slice(0, 200) });
    }
  }

  // Tous ont échoué
  const err = new Error(`All LLM providers failed (${tried.join(' → ')})`);
  err.tried = tried;
  err.errors = errors;
  throw err;
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

  const DOCS = await loadDocsMap(env);
  for (const [name, docId] of Object.entries(DOCS)) {
    const startMs = Date.now();
    try {
      // 1. Fetch doc
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const res = await fetch(exportUrl);
      if (!res.ok) {
        results[name] = { ok: false, error: `HTTP ${res.status}` };
        console.log(`[sync.js] eleve=${name} step=doc_fetch status=${res.status}`);
        continue;
      }
      const docText = await res.text();

      // 2. Stats auto via regex (ne dépend pas du LLM)
      const sessionTitles = parseSessionTitles(docText);
      const statsAutoRaw = computeAutoStats(sessionTitles);
      console.log(`[sync.js] eleve=${name} step=stats_auto nb_cours=${statsAutoRaw.nb_cours} debut=${statsAutoRaw.date_debut} fin=${statsAutoRaw.date_fin_prevue}`);

      // 3. LLM cascade pour derniere_seance uniquement (Gemini → Groq → Claude)
      let extracted;
      try {
        extracted = await extractLatestSession(docText, name, capitalize(name), env);
      } catch (llmErr) {
        // Tous les LLM ont échoué → ne pas toucher le cache existant (stale préservé)
        const cacheKey = `eleve:${name}`;
        const existing = await env.MASTERHUB_STUDENTS.get(cacheKey, { type: 'json' });
        llmFailed.push({
          eleve: name,
          providers_tried: llmErr.tried || [],
          errors: (llmErr.errors || []).map(e => ({ provider: e.provider, message: e.message })),
          has_stale_cache: !!existing,
        });
        results[name] = {
          ok: false,
          error: 'All LLM providers failed',
          providers_tried: llmErr.tried || [],
          stale_cache_available: !!existing,
        };
        console.error(`[sync.js] eleve=${name} step=llm_cascade status=all_failed providers=${(llmErr.tried || []).join(',')} stale=${!!existing}`);
        continue;
      }

      // 4. Merge avec KV existant + override prioritaire
      const cacheKey = `eleve:${name}`;
      const existing = await env.MASTERHUB_STUDENTS.get(cacheKey, { type: 'json' }) || {};
      const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

      // Override préservé tel quel entre syncs (spread = robuste à l'ajout futur de champs).
      const statsOverride = { ...(existing?.stats_override || {}) };
      const stats = mergeStats(statsAutoRaw, statsOverride);

      const updated = {
        // Préserve tout l'existant (theorie, canaux, repertoire, notes, statut, etc.)
        ...existing,
        // Overrides canoniques
        id: name,
        nom: capitalize(name),
        // doc_id/doc_url : préserve l'édition admin (existing) sur le fallback (docId
        // venant de loadDocsMap, qui lit déjà KV mais retombe sur FALLBACK_DOCS si
        // KV vide). Belt-and-suspenders : empêche tout retour au hardcoded même
        // en cas d'incohérence KV.
        doc_id: existing.doc_id || docId,
        doc_url: existing.doc_url || docUrl,
        derniere_seance: extracted.parsed,
        // Stats : bloc fusionné + bloc raw (pour reset) + override (persistant)
        stats,
        stats_auto_raw: statsAutoRaw,
        stats_override: statsOverride,
        // Aliases top-level pour compat client actuel
        sessionCount: stats.nb_cours,
        progression: stats.progression_pct,
        _syncedAt: new Date().toISOString(),
        _cachedAt: Date.now(),
      };

      // Pas de TTL : sync écrase volontairement les champs LLM frais (derniere_seance,
      // stats_auto_raw, stats recomputés) tout en préservant `existing.stats_override`
      // via le merge construit ci-dessus.
      await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(updated));
      results[name] = {
        ok: true,
        provider: extracted.provider,
        nb_cours: stats.nb_cours,
        date_debut: stats.date_debut,
        date_fin: stats.date_fin,
        progression: stats.progression_pct,
        derniere_seance_date: extracted.parsed?.date,
        derniere_seance_titre: extracted.parsed?.titre,
      };
      console.log(`[sync.js] eleve=${name} step=done provider=${extracted.provider} duration=${Date.now()-startMs}ms override=${stats.override_active.date_debut || stats.override_active.date_fin ? 'yes' : 'no'}`);

    } catch (e) {
      results[name] = { ok: false, error: e.message };
      console.error(`[sync.js] eleve=${name} unexpected_error="${e.message}"`);
    }
  }

  if (llmFailed.length > 0) {
    return jsonResponse({
      ok: false,
      error: 'Tous les fournisseurs LLM ont échoué pour certains élèves',
      failed: llmFailed,
      providers_available: [
        env.GEMINI_API_KEY ? 'gemini' : null,
        env.GROQ_API_KEY ? 'groq' : null,
        env.ANTHROPIC_API_KEY ? 'claude' : null,
      ].filter(Boolean),
      results,
    }, 503);
  }
  return jsonResponse({ ok: true, success: true, results });
}
