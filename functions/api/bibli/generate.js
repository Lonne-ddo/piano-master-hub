// ─── POST /api/bibli/generate ────────────────────────────────────
// Génère paroles + accords (format ChordPro) d'un morceau via Groq.
//
// Body : { titre, artiste?, genre? }
//   titre : string non vide, 2-100 chars
//   artiste : optionnel, 0-50 chars
//   genre : optionnel, ∈ VALID_GENRES
//
// Response : 2 formats possibles selon que le LLM connaît le morceau ou non.
//
//   Cas EXACT (morceau connu) :
//   { ok: true, type: 'exact', titre, artiste, tonalite, tonalite_label_fr,
//     bpm, genre, sections: [{ type, label, lines }], chord_count }
//
//   Cas SUGGESTIONS (morceau inconnu, LLM propose 3 alternatives) :
//   { ok: true, type: 'suggestions', message,
//     suggestions: [{ titre, artiste, raison }] }
//
// Pas d'auth (page élève publique avec slug whitelist côté frontend).
// Pas de palette d'accords contrainte : le LLM utilise la notation jazz complète,
// le frontend simplifie via le mode toggle (Original/Simplifié).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_GENRES = ['variete-francaise', 'pop', 'gospel', 'jazz', 'rock', 'autre'];

// Palette des suffixes notation jazz autorisés — alignée avec MhTheory.CHORD_TYPES
// (22 types). Le LLM doit s'y tenir ; le frontend gère la simplification visuelle.
const PALETTE_LLM = [
  '(rien)', 'm', 'dim', 'aug', 'sus2', 'sus4',
  '7', 'maj7', 'm7', 'm7b5', 'dim7', 'mMaj7',
  '6', 'm6', 'add9', '9', '13', 'm11',
  '7sus4', '7b9', '7#5', '7#9',
];

// Strip caractères de contrôle + brackets ChordPro ([], {}) + tags HTML (<, >).
function sanitizeFreeText(s, maxLen) {
  if (typeof s !== 'string') return '';
  let out = s.replace(/[\x00-\x1F\x7F\[\]{}<>]/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out.slice(0, maxLen);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const titre = sanitizeFreeText(body.titre, 100);
  if (titre.length < 2) {
    return json({ error: 'invalid_titre' }, 400);
  }
  const artiste = sanitizeFreeText(body.artiste, 50);
  const genre = body.genre ? String(body.genre).trim().toLowerCase() : '';
  if (genre && !VALID_GENRES.includes(genre)) {
    return json({ error: 'invalid_genre' }, 400);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: 'groq_not_configured' }, 500);
  }

  const paletteStr = PALETTE_LLM.join(', ');

  const systemPrompt = `Tu es un expert en transcription d'accords pour piano. Tu réponds UNIQUEMENT en JSON pur valide (pas de markdown, pas de backticks, pas de texte autour).`;

  const userPrompt = `Génère les accords + paroles du morceau "${titre}"${artiste ? ' de ' + artiste : ''}${genre ? ' (genre: ' + genre + ')' : ''}.

Tu DOIS retourner UN SEUL des deux formats JSON suivants — JAMAIS un mélange.

═══ CAS 1 — Tu CONNAIS ce morceau précis avec certitude ═══

{
  "type": "exact",
  "titre": "<titre exact>",
  "artiste": "<artiste exact, ou \\"\\" si inconnu>",
  "tonalite": "<ex: Dm, C, F>",
  "tonalite_label_fr": "<ex: Ré mineur, Do majeur>",
  "bpm": <nombre entier réaliste, ex 76>,
  "genre": "<un des: variete-francaise, pop, gospel, jazz, rock, autre>",
  "sections": [
    {
      "type": "<intro|couplet|refrain|pont|outro>",
      "label": "<ex: Couplet 1, Refrain, Pont>",
      "lines": ["<ligne ChordPro>", ...]
    }
  ]
}

CONTRAINTES CAS 1 :
1. Format ChordPro : accords entre crochets [Dm] juste avant la syllabe où l'accord change. Ex : "[Dm]Je vous parle d'un [Bm7b5]temps".
2. Plusieurs accords sans paroles (intro instrumentale) : "[A7] [Dm] [Am7]" sur une ligne.
3. PALETTE D'ACCORDS AUTORISÉE (suffixes après [A-G] avec # ou b optionnel) :
   ${paletteStr}
   Si l'accord original n'est pas dans cette palette, simplifie au plus proche dans la palette. Slash chords (C/E) → ignore le bass note, garde "C".
4. Tonalité ORIGINALE du morceau (pas transposée).
5. BPM : tempo réel si connu, sinon estime selon le genre (ballade=70, midtempo=100, rapide=130).
6. COPYRIGHT : pour les paroles, donne UNIQUEMENT les premiers 5-8 mots de chaque ligne.
7. Au moins 2 sections (couplet + refrain typiquement). 4 à 8 lignes par section maximum.
8. Tonalité format : root [A-G] avec # ou b optionnel, suivi de 'm' si mineure. Ex: "C", "Dm", "Bb", "F#m".

═══ CAS 2 — Tu ne CONNAIS PAS ce morceau précis ═══

{
  "type": "suggestions",
  "message": "<phrase courte qui explique que tu ne connais pas et que tu proposes des alternatives>",
  "suggestions": [
    { "titre": "<titre exact>", "artiste": "<artiste exact>", "raison": "<phrase courte expliquant pourquoi cette alternative>" },
    { "titre": "...", "artiste": "...", "raison": "..." },
    { "titre": "...", "artiste": "...", "raison": "..." }
  ]
}

CONTRAINTES CAS 2 :
1. EXACTEMENT 3 suggestions, pas plus, pas moins.
2. Les suggestions doivent être des morceaux que tu CONNAIS et qui sont PROCHES du morceau demandé :
   - Même artiste si possible (ex: demandé "Burna Boy unknown" → propose 3 morceaux de Burna Boy connus de toi)
   - Même genre, même époque, même style sinon
3. La "raison" explique le lien (ex: "même artiste", "style afrobeats similaire", "ballade gospel similaire").
4. Le message peut être court : "Je ne connais pas ce morceau précis. Voici 3 alternatives proches :"

═══ RÈGLE IMPORTANTE ═══

Si tu connais le morceau → CAS 1 (jamais le cas 2 par paresse).
Si tu ne le connais pas → CAS 2 (jamais inventer un morceau pour le cas 1).
TOUJOURS retourner un JSON valide. JAMAIS de "found: false" ou autre format.

Réponds UNIQUEMENT avec le JSON.`;

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    console.error('[bibli/generate] fetch failed:', e?.message);
    return json({ error: 'groq_unreachable' }, 502);
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => '');
    console.error('[bibli/generate] Groq HTTP', groqRes.status, errText.slice(0, 200));
    return json({ error: 'groq_failed', status: groqRes.status }, 502);
  }

  let groqData;
  try { groqData = await groqRes.json(); }
  catch { return json({ error: 'invalid_groq_response' }, 502); }

  const text = groqData?.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    console.error('[bibli/generate] JSON parse failed, raw:', text.slice(0, 300));
    return json({ error: 'invalid_llm_output' }, 502);
  }

  if (!parsed || typeof parsed !== 'object') {
    return json({ error: 'invalid_structure' }, 502);
  }

  // Détection du format de réponse (LLM peut omettre le `type` explicite)
  const isSuggestions = parsed.type === 'suggestions' || Array.isArray(parsed.suggestions);
  const isExact = parsed.type === 'exact' || Array.isArray(parsed.sections);

  if (isSuggestions) {
    const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const suggestions = rawSuggestions
      .filter(s => s && typeof s === 'object')
      .map(s => ({
        titre: sanitizeFreeText(s.titre || '', 100),
        artiste: sanitizeFreeText(s.artiste || '', 50),
        raison: sanitizeFreeText(s.raison || '', 200),
      }))
      .filter(s => s.titre.length > 0)
      .slice(0, 5);

    if (suggestions.length === 0) {
      return json({ error: 'no_valid_suggestions' }, 502);
    }

    return json({
      ok: true,
      type: 'suggestions',
      message: typeof parsed.message === 'string'
        ? parsed.message.slice(0, 250)
        : 'Je ne connais pas ce morceau précis. Voici des alternatives proches :',
      suggestions,
    });
  }

  if (!isExact) {
    return json({ error: 'invalid_structure' }, 502);
  }

  // Validation post-LLM (cas exact)
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    return json({ error: 'invalid_sections' }, 502);
  }

  const sections = parsed.sections
    .filter(s => s && typeof s === 'object' && Array.isArray(s.lines) && s.lines.length > 0)
    .map(s => ({
      type: typeof s.type === 'string' ? s.type : 'couplet',
      label: typeof s.label === 'string' ? s.label : 'Section',
      lines: s.lines.filter(l => typeof l === 'string'),
    }))
    .filter(s => s.lines.length > 0);

  if (sections.length === 0) {
    return json({ error: 'no_valid_sections' }, 502);
  }

  // Compte total des accords (pour stats / debug)
  const chordRe = /\[([^\]]+)\]/g;
  let chordCount = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      chordRe.lastIndex = 0;
      while (chordRe.exec(line) !== null) chordCount++;
    }
  }
  if (chordCount === 0) {
    return json({ error: 'no_chords_found' }, 502);
  }

  return json({
    ok: true,
    type: 'exact',
    titre: typeof parsed.titre === 'string' ? parsed.titre : titre,
    artiste: typeof parsed.artiste === 'string' ? parsed.artiste : artiste,
    tonalite: typeof parsed.tonalite === 'string' ? parsed.tonalite : '',
    tonalite_label_fr: typeof parsed.tonalite_label_fr === 'string' ? parsed.tonalite_label_fr : '',
    bpm: Number.isInteger(parsed.bpm) && parsed.bpm >= 40 && parsed.bpm <= 220 ? parsed.bpm : 100,
    genre: typeof parsed.genre === 'string' ? parsed.genre : (genre || ''),
    sections,
    chord_count: chordCount,
  });
}
