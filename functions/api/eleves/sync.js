// ─── Sync élèves depuis Google Docs ──────────────────────────────
// POST /api/eleves/sync — parse les docs, résumé via Gemini → Groq, merge KV
// Auth : header x-admin-secret requis

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

const PROTECTED_FIELDS = [
  'premier_cours', 'fin_prevue', 'statut', 'programme', 'notes', 'manualDates',
];

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
  try {
    return await callGemini(prompt, env.GEMINI_API_KEY, opts);
  } catch (e) {
    console.log('[callLLM] Gemini failed:', e.message);
    if (!isRetryableError(e)) throw e;
  }
  try {
    return await callGroq(prompt, env.GROQ_API_KEY, opts);
  } catch (e) {
    console.log('[callLLM] Groq failed:', e.message);
    throw e;
  }
}

function extractJSON(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

// ─── POST /api/eleves/sync ───────────────────────────────────────
// Comportement :
//  - Itère sur les 4 élèves
//  - Chaque élève avec LLM OK → put KV mis à jour
//  - Chaque élève avec LLM qui casse (Gemini + Groq KO) → tracké dans llmFailed, KV inchangé
//  - Si au moins un LLM failed → 503 avec { error, failed: [...], results }
//  - Sinon → 200 avec { success: true, results }
export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const results = {};
  const llmFailed = [];

  for (const [name, docId] of Object.entries(DOCS)) {
    try {
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const res = await fetch(exportUrl);
      if (!res.ok) {
        results[name] = { error: `HTTP ${res.status}` };
        continue;
      }
      const text = await res.text();
      const parsed = parseStudentDoc(text, name);

      // Résumé des 5 séances les plus récentes via LLM chain
      let summarized;
      try {
        const toSummarize = parsed.seances.slice(-5);
        summarized = await Promise.all(
          toSummarize.map(s => summarizeSession(s, env))
        );
      } catch (llmErr) {
        llmFailed.push(name);
        results[name] = { error: `LLM unavailable: ${llmErr.message}` };
        continue;
      }
      const older = parsed.seances.slice(0, -5);
      const allSeances = [...older, ...summarized];

      const cacheKey = `eleve:${name}`;
      const existing = await env.MASTERHUB_STUDENTS.get(cacheKey, { type: 'json' }) || {};

      const updated = {
        id: name,
        nom: capitalize(name),
        programme: 'Piano Master',
        statut: 'actif',
        doc_url: `https://docs.google.com/document/d/${docId}/edit`,
        ...parsed,
        ...existing,
        id: name,
        nom: capitalize(name),
        doc_url: `https://docs.google.com/document/d/${docId}/edit`,
        sessions: parsed.sessions,
        seances: allSeances,
        sessionCount: parsed.sessions.length,
        lastSession: parsed.sessions[0]?.date || existing.lastSession || null,
        theoryCovered: parsed.theoryCovered,
        theorie: parsed.theorie,
        progression: parsed.progression,
        _syncedAt: new Date().toISOString(),
        _cachedAt: Date.now(),
      };

      for (const field of PROTECTED_FIELDS) {
        if (existing[field] !== undefined) {
          updated[field] = existing[field];
        }
      }

      await env.MASTERHUB_STUDENTS.put(cacheKey, JSON.stringify(updated), { expirationTtl: 3600 });
      results[name] = { ok: true, sessions: parsed.sessions.length };

    } catch (e) {
      results[name] = { error: e.message };
    }
  }

  if (llmFailed.length > 0) {
    return jsonResponse({ error: 'LLM unavailable', failed: llmFailed, results }, 503);
  }
  return jsonResponse({ success: true, results });
}

// ─── RÉSUMÉ SÉANCE via LLM chain ─────────────────────────────────
async function summarizeSession(session, env) {
  const contentLines = [
    session.contenu?.length  ? 'Contenu : ' + session.contenu.join(' / ')  : '',
    session.devoirs?.length  ? 'Devoirs : ' + session.devoirs.join(' / ')  : '',
    session.conseils?.length ? 'Conseils : ' + session.conseils.join(' / ') : '',
    session.rappels?.length  ? 'Rappels : ' + session.rappels.join(' / ')  : '',
  ].filter(Boolean).join('\n');

  if (!contentLines.trim()) return session;

  const prompt = `Voici les notes d'une séance de piano du ${session.date}.
Résume en 2-4 points courts sans redites, en français, style télégraphique.
Sépare contenu travaillé et devoirs s'ils sont distincts.
Retourne UNIQUEMENT un JSON : { "contenu": ["...", "..."], "devoirs": ["...", "..."] }

Notes brutes :
${contentLines}`;

  const text = await callLLM(prompt, env, { maxTokens: 300, temperature: 0.3 });
  const clean = extractJSON(text);
  const summary = JSON.parse(clean);

  return {
    ...session,
    focus: summary.contenu?.[0] || session.focus,
    contenu: summary.contenu || session.contenu,
    devoirs: summary.devoirs || session.devoirs,
    summarized: true,
  };
}

// ─── PARSER ──────────────────────────────────────────────────────
function parseStudentDoc(text, studentName) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const sessionRegex = /^(\d{1,2}\/\d{2}|Tab\s+\d+)$/i;

  const sessions = [];
  let currentSession = null;
  let currentSection = null;

  for (const line of lines) {
    if (sessionRegex.test(line)) {
      if (currentSession) sessions.push(currentSession);
      currentSession = {
        date: line,
        devoirs: [],
        conseils: [],
        rappels: [],
        contenu: [],
        raw: [],
      };
      currentSection = null;
      continue;
    }

    if (!currentSession) continue;

    const lower = line.toLowerCase();
    if (lower.startsWith('a faire') || lower.startsWith('à faire')) {
      currentSection = 'devoirs';
      continue;
    }
    if (lower.startsWith('conseils')) {
      currentSection = 'conseils';
      continue;
    }
    if (lower.startsWith('rappels')) {
      currentSection = 'rappels';
      continue;
    }

    if (line.startsWith('Général') || line.startsWith('PRATIQUE')) {
      currentSection = null;
      continue;
    }

    if (currentSection && (line.startsWith('-') || line.startsWith('•') || line.startsWith('*'))) {
      const item = line.replace(/^[-•*]\s*/, '').trim();
      if (item) currentSession[currentSection].push(item);
    } else if (currentSection) {
      currentSession[currentSection].push(line);
    } else {
      if (line.startsWith('-') || line.startsWith('•') || line.startsWith('*')) {
        const item = line.replace(/^[-•*]\s*/, '').trim();
        if (item) currentSession.contenu.push(item);
      }
    }
  }

  if (currentSession) sessions.push(currentSession);

  sessions.reverse();

  const seances = sessions.map(s => ({
    date: s.date,
    focus: s.contenu[0] || s.devoirs[0] || s.date,
    contenu: s.contenu.length ? s.contenu : [...s.conseils, ...s.rappels],
    devoirs: s.devoirs,
  }));

  // ─── THÉORIE COUVERTE ──────────────────────────────────────────
  const fullText = text.toLowerCase();
  const THEORY_MILESTONES = [
    { key: 'posture',       label: 'Posture & installation',       keywords: ['posture', 'position'] },
    { key: 'notes',         label: 'Lecture de notes',             keywords: ['notes', 'lecture', 'module 1', 'module 2'] },
    { key: 'gammes',        label: 'Gammes majeures / mineures',  keywords: ['gamme', 'gammes', 'module 3'] },
    { key: 'intervalles',   label: 'Intervalles',                  keywords: ['intervalle', 'intervalles', 'module 4'] },
    { key: 'degres',        label: 'Système des degrés',          keywords: ['degrés', 'degre', 'degré', 'module 4'] },
    { key: 'accords',       label: 'Accords & grilles',           keywords: ['accord', 'triade', 'grille', 'module 5'] },
    { key: 'renversements', label: "Renversements d'accords",     keywords: ['renversement', 'module 5'] },
    { key: 'enrichis',      label: 'Accords enrichis',            keywords: ['enrichi', 'maj7', 'min7', 'dom7', 'module 6'] },
    { key: 'eartraining',   label: 'Ear training',                keywords: ['ear training', 'oreille', 'tonedear'] },
    { key: 'arpeges',       label: 'Arpèges',                     keywords: ['arpège', 'arpege', 'arpèges'] },
  ];

  const theoryCovered = {};
  let coveredCount = 0;
  const theorie = [];

  for (const milestone of THEORY_MILESTONES) {
    const found = milestone.keywords.some(kw => fullText.includes(kw));
    theoryCovered[milestone.key] = found;
    if (found) coveredCount++;
    theorie.push({
      label: milestone.label,
      statut: found ? 'done' : 'todo',
    });
  }

  const progression = Math.round((coveredCount / THEORY_MILESTONES.length) * 100);

  return { sessions, seances: seances.reverse(), theoryCovered, theorie, progression };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
