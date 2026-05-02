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

// ─── LLM providers (JSON natif forcé) ─────────────────────────────
// Cascade Gemini → Groq pour Bibli : Gemini Flash a un meilleur corpus
// pour les morceaux moins mainstream (afrobeats, gospel non-anglophone, etc.).
// Groq Llama 3.3 70B reste le fallback rapide.

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
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens || 6000,
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
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens || 6000,
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

  const systemPrompt = `Tu es un expert en transcription musicale pour piano, spécialisé dans les arrangements pédagogiques. Tu connais des milliers de morceaux : standards de jazz, soul, gospel, pop classique, variété francophone, afrobeats, R&B, rap mainstream, rock, classique, etc.

Ta mission : transcrire des morceaux en format ChordPro avec une fidélité maximale, à destination d'élèves pianistes en cours de coaching privé.

PRIORITÉS (par ordre d'importance) :

1. EXACTITUDE des accords : utilise les VRAIS accords du morceau, pas des simplifications. Si le morceau utilise un Cdim7, écris Cdim7. Tous les types disponibles : maj, min, dim, aug, sus2, sus4, 7, maj7, min7, min7b5, dim7, mMaj7, 6, min6, add9, 9, 11, 13, min9, min11, 7sus4, 7b9, 7#9, 7#5, etc.

2. STRUCTURE COMPLÈTE : génère TOUTES les sections du morceau :
   - Intro (si présente)
   - Tous les couplets ("Couplet 1", "Couplet 2", "Couplet 3"...)
   - Tous les refrains
   - Pont / bridge (si présent)
   - Solo (si instrumentale notable, juste les accords)
   - Outro (si présente)
   ⚠️ Minimum 4 sections par morceau (sauf si vraiment très court).

3. PAROLES : 10-15 premiers mots par ligne (assez pour reconnaître le morceau et placer les accords correctement).

4. PLACEMENT précis des accords [X] juste avant la syllabe où l'accord change.

5. TONALITÉ originale du morceau.

6. BPM réel du morceau si tu le connais.

Ne réponds qu'en JSON pur (pas de markdown, pas de backticks).`;

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

1. FORMAT ChordPro : accords entre crochets [Dm] juste avant la syllabe où l'accord change. Ex : "[Dm]Je vous parle d'un [Bm7b5]temps".
   Plusieurs accords sans paroles (intro instrumentale) : "[A7] [Dm] [Am7]" sur une ligne.

2. EXHAUSTIVITÉ — AU MOINS 4 SECTIONS distinctes. Pour un morceau standard :
   - intro instrumentale (si elle existe)
   - couplet 1, couplet 2, couplet 3 — distinguer les variations harmoniques entre eux
   - refrain (chœur) avec ses variations
   - pont si présent
   - solo / outro / coda si présents
   N'omets PAS les sections instrumentales. Le but est de couvrir l'intégralité de la structure.

3. AU MOINS 12 LIGNES TOTAL réparties sur les sections.

4. EXEMPLE DE QUALITÉ ATTENDUE — pour "Isn't She Lovely" de Stevie Wonder :
   - 8+ sections : intro long, 3 couplets, 3 refrains, solo harmonica, outro
   - 20+ lignes
   - Variété d'accords typique soul/jazz : E, B7, A, A7, F#m7, Cdim7

5. PALETTE D'ACCORDS AUTORISÉE (suffixes après [A-G] avec # ou b optionnel) :
   ${paletteStr}
   Si l'accord original n'est pas dans cette palette, simplifie au plus proche dans la palette. Slash chords (C/E) → ignore le bass note, garde "C".

6. ZÉRO HALLUCINATION — n'invente PAS d'accords ou de paroles. Si tu ne connais
   pas une partie précise du morceau, omets-la. Si tu ne peux pas atteindre 4 sections
   et 12 lignes avec certitude → bascule sur le CAS 2 (suggestions).

7. PAROLES — 10 à 15 mots par ligne maximum. Suffisant pour identifier le morceau
   sans risque copyright (usage pédagogique privé pour 4 élèves coachés).

8. TONALITÉ ORIGINALE du morceau (pas transposée). Format : root [A-G] avec # ou b
   optionnel, suivi de 'm' si mineure. Ex: "C", "Dm", "Bb", "F#m".

9. BPM : tempo réel si connu, sinon estime selon le genre (ballade=70, midtempo=100, rapide=130).

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

  // ── Cascade Groq → Gemini ─────────────────────────────────────
  // Stratégie : Groq en primary (rapide, bon corpus mainstream). Si Groq retourne
  // 'suggestions' (morceau pas connu) OU si Groq fail, on tente Gemini Flash
  // (corpus plus large pour les niches afrobeats / gospel non-anglo / etc.).
  // On garde la meilleure réponse (exact > suggestions).
  const opts = { temperature: 0.3, maxTokens: 6000 };
  let groqOutcome = null, geminiOutcome = null;

  if (env.GROQ_API_KEY) {
    try {
      const raw = await callGroq(systemPrompt, userPrompt, env.GROQ_API_KEY, opts);
      groqOutcome = parseAndClassify(raw);
    } catch (e) {
      console.warn('[bibli/generate] Groq failed:', e?.message);
    }
  }

  // Si Groq a trouvé un exact, on retourne tout de suite (rapide).
  if (groqOutcome && groqOutcome.kind === 'exact') {
    return jsonExact(groqOutcome.parsed, titre, artiste, genre, 'groq');
  }

  // Sinon, on tente Gemini (soit Groq a renvoyé suggestions, soit fail).
  if (env.GEMINI_API_KEY) {
    try {
      const raw = await callGemini(systemPrompt, userPrompt, env.GEMINI_API_KEY, opts);
      geminiOutcome = parseAndClassify(raw);
    } catch (e) {
      console.warn('[bibli/generate] Gemini failed:', e?.message);
    }
  }

  // Préférence : exact > suggestions ; Gemini > Groq pour les suggestions
  // (corpus plus large = alternatives potentiellement plus pertinentes).
  if (geminiOutcome && geminiOutcome.kind === 'exact') {
    return jsonExact(geminiOutcome.parsed, titre, artiste, genre, 'gemini');
  }
  if (geminiOutcome && geminiOutcome.kind === 'suggestions') {
    return jsonSuggestions(geminiOutcome.parsed, 'gemini');
  }
  if (groqOutcome && groqOutcome.kind === 'suggestions') {
    return jsonSuggestions(groqOutcome.parsed, 'groq');
  }

  // Aucun provider n'a renvoyé quelque chose d'exploitable
  return json({ error: 'all_llms_failed', tried: ['groq', 'gemini'] }, 502);
}

// ─── Helpers parse/classify/format ────────────────────────────────

function parseAndClassify(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    console.warn('[bibli/generate] JSON parse failed, raw:', String(rawText).slice(0, 200));
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const isExact = parsed.type === 'exact' || Array.isArray(parsed.sections);
  if (isExact && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
    return { kind: 'exact', parsed };
  }

  const isSuggestions = parsed.type === 'suggestions' || Array.isArray(parsed.suggestions);
  if (isSuggestions && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
    return { kind: 'suggestions', parsed };
  }
  return null;
}

function jsonSuggestions(parsed, provider) {
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
    return new Response(JSON.stringify({ error: 'no_valid_suggestions' }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    type: 'suggestions',
    message: typeof parsed.message === 'string'
      ? parsed.message.slice(0, 250)
      : 'Je ne connais pas ce morceau précis. Voici des alternatives proches :',
    suggestions,
    _provider: provider,
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function jsonExact(parsed, titre, artiste, genre, provider) {
  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .filter(s => s && typeof s === 'object' && Array.isArray(s.lines) && s.lines.length > 0)
    .map(s => ({
      type: typeof s.type === 'string' ? s.type : 'couplet',
      label: typeof s.label === 'string' ? s.label : 'Section',
      lines: s.lines.filter(l => typeof l === 'string'),
    }))
    .filter(s => s.lines.length > 0);

  if (sections.length === 0) {
    return new Response(JSON.stringify({ error: 'no_valid_sections' }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const chordRe = /\[([^\]]+)\]/g;
  let chordCount = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      chordRe.lastIndex = 0;
      while (chordRe.exec(line) !== null) chordCount++;
    }
  }
  if (chordCount === 0) {
    return new Response(JSON.stringify({ error: 'no_chords_found' }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
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
    _provider: provider,
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
