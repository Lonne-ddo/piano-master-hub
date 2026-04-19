// ─── Sync élèves depuis Google Docs ──────────────────────────────
// POST /api/eleves/sync — parse les docs texte, résumé via Gemini, merge KV
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

// Map élève → Google Doc ID
const DOCS = {
  japhet: '19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM',
  messon: '1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI',
  dexter: '1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A',
  tara:   '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY',
};

// Champs saisis manuellement → jamais écrasés par le sync
const PROTECTED_FIELDS = [
  'premier_cours',
  'fin_prevue',
  'statut',
  'programme',
  'notes',
  'manualDates',
];

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const results = {};

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

      // Résumer les 5 séances les plus récentes via Gemini
      const toSummarize = parsed.seances.slice(-5);
      const older = parsed.seances.slice(0, -5);
      const summarized = await Promise.all(
        toSummarize.map(s => summarizeSession(s, env))
      );
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

  return jsonResponse({ success: true, results });
}

// ─── RÉSUMÉ VIA GEMINI FLASH ─────────────────────────────────────
async function summarizeSession(session, env) {
  const contentLines = [
    session.contenu?.length  ? 'Contenu : ' + session.contenu.join(' / ')  : '',
    session.devoirs?.length  ? 'Devoirs : ' + session.devoirs.join(' / ')  : '',
    session.conseils?.length ? 'Conseils : ' + session.conseils.join(' / ') : '',
    session.rappels?.length  ? 'Rappels : ' + session.rappels.join(' / ')  : '',
  ].filter(Boolean).join('\n');

  if (!contentLines.trim()) return session;

  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY manquante');
  }

  const prompt = `Voici les notes d'une séance de piano du ${session.date}.
Résume en 2-4 points courts sans redites, en français, style télégraphique.
Sépare contenu travaillé et devoirs s'ils sont distincts.
Retourne UNIQUEMENT un JSON : { "contenu": ["...", "..."], "devoirs": ["...", "..."] }

Notes brutes :
${contentLines}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
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
