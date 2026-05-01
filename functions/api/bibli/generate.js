// ─── POST /api/bibli/generate ────────────────────────────────────
// Génère paroles + accords (format ChordPro) d'un morceau via Groq.
//
// Body : { titre, artiste?, genre?, niveau }
//   titre : string non vide, 2-150 chars
//   artiste : optionnel, 0-100 chars
//   genre : optionnel, ∈ VALID_GENRES
//   niveau : ∈ VALID_NIVEAUX (palette d'accords contraint le LLM)
//
// Response : { ok: true, found: true, titre, artiste, tonalite, tonalite_label_fr,
//              bpm, genre, sections: [{ type, label, lines: [...] }] }
//   Ou : { ok: true, found: false, message: '...' } si LLM ne connaît pas le morceau.
// Pas d'auth (page élève publique avec slug whitelist côté frontend).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_NIVEAUX = ['debutant', 'intermediaire', 'avance'];
const VALID_GENRES = ['variete-francaise', 'pop', 'gospel', 'jazz', 'rock', 'autre'];

// Palettes d'accords par niveau (suffixes notation jazz LLM, pas notation MhTheory)
const NIVEAU_PALETTES = {
  debutant: ['(rien)', 'm', 'dim', '7'],
  intermediaire: ['(rien)', 'm', 'dim', 'aug', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim7'],
  avance: ['(rien)', 'm', 'dim', 'aug', 'sus2', 'sus4', '7', 'maj7', 'm7', 'm7b5', 'dim7', 'mMaj7', '6', 'm6', 'add9', '9', '13', 'm11', '7sus4', '7b9', '7#5', '7#9'],
};

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

  const titre = String(body.titre || '').trim();
  if (titre.length < 2 || titre.length > 150) {
    return json({ error: 'invalid_titre' }, 400);
  }
  const artiste = body.artiste ? String(body.artiste).trim().slice(0, 100) : '';
  const genre = body.genre ? String(body.genre).trim().toLowerCase() : '';
  if (genre && !VALID_GENRES.includes(genre)) {
    return json({ error: 'invalid_genre' }, 400);
  }
  const niveau = String(body.niveau || '').toLowerCase();
  if (!VALID_NIVEAUX.includes(niveau)) {
    return json({ error: 'invalid_niveau' }, 400);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: 'groq_not_configured' }, 500);
  }

  const palette = NIVEAU_PALETTES[niveau];
  const paletteStr = palette.join(', ');

  const systemPrompt = `Tu es un expert en transcription d'accords pour piano. Tu réponds UNIQUEMENT en JSON pur valide (pas de markdown, pas de backticks, pas de texte autour).`;

  const userPrompt = `Génère les accords + paroles du morceau "${titre}"${artiste ? ' de ' + artiste : ''}${genre ? ' (genre: ' + genre + ')' : ''}.

CONTRAINTES :

1. Format de sortie : JSON strict avec structure :
{
  "found": true,
  "titre": "<titre exact>",
  "artiste": "<artiste exact, ou '' si inconnu>",
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

2. Format ChordPro pour les paroles :
   - Mettre les accords entre crochets [Dm] juste avant la syllabe où l'accord change
   - Exemple : "[Dm]Je vous parle d'un [Bm7b5]temps"
   - Plusieurs accords sans paroles (intro/outro instrumentale) : "[A7] [Dm] [Am7]"
   - Sections sans paroles : juste les accords sur une ligne

3. PALETTE D'ACCORDS AUTORISÉE (suffixes après [A-G] avec # ou b optionnel) :
   ${paletteStr}

   Si l'accord original du morceau n'est pas dans cette palette, simplifie au plus proche dans la palette :
   - Cmaj9 → Cmaj7 (intermédiaire) ou C (débutant)
   - C13 → C7 (intermédiaire et débutant)
   - Cm9 → Cm7 (intermédiaire) ou Cm (débutant)
   - Slash chords (C/E) → ignore le bass note, garde juste C
   INTERDIT FORMELLEMENT : utiliser un suffixe hors palette. Cette règle est PRIORITAIRE.

4. Si le morceau n'est PAS connu de toi avec certitude, retourne :
   { "found": false, "message": "Morceau non trouvé. Essaie un autre titre ou ajoute le nom de l'artiste." }
   IMPORTANT : ne PAS inventer un morceau. Mieux vaut dire qu'il n'est pas connu.

5. La tonalité retournée doit être la TONALITÉ ORIGINALE du morceau (pas transposée). L'élève transposera ensuite côté frontend.

6. BPM : indique le tempo réel du morceau si tu le connais, sinon estime selon le genre (ballade=70, midtempo=100, rapide=130).

7. COPYRIGHT : pour les paroles, donne UNIQUEMENT les premiers 5-8 mots de chaque ligne (pas les paroles complètes). L'élève reconnaîtra le morceau au placement des accords.

8. Au moins 2 sections (couplet + refrain typiquement). 4 à 8 lignes par section maximum.

9. Tonalité format : root [A-G] avec # ou b optionnel, suivi de 'm' si mineure. Ex: "C", "Dm", "Bb", "F#m".

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

  // Cas "non trouvé" : on renvoie tel quel pour que le frontend affiche le message.
  if (parsed.found === false) {
    return json({
      ok: true,
      found: false,
      message: typeof parsed.message === 'string' ? parsed.message : 'Morceau non trouvé.',
    });
  }

  // Validation post-LLM (cas trouvé)
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

  // Audit : extraire tous les accords trouvés via regex et logger les hors-palette
  // (pas bloquant — le LLM essaye de simplifier mais peut rater).
  const chordRe = /\[([^\]]+)\]/g;
  const allChords = [];
  for (const section of sections) {
    for (const line of section.lines) {
      let m;
      chordRe.lastIndex = 0;
      while ((m = chordRe.exec(line)) !== null) allChords.push(m[1]);
    }
  }
  // (palette-check côté frontend si besoin — on log juste ici)
  if (allChords.length === 0) {
    return json({ error: 'no_chords_found' }, 502);
  }

  return json({
    ok: true,
    found: true,
    titre: typeof parsed.titre === 'string' ? parsed.titre : titre,
    artiste: typeof parsed.artiste === 'string' ? parsed.artiste : artiste,
    tonalite: typeof parsed.tonalite === 'string' ? parsed.tonalite : '',
    tonalite_label_fr: typeof parsed.tonalite_label_fr === 'string' ? parsed.tonalite_label_fr : '',
    bpm: Number.isInteger(parsed.bpm) && parsed.bpm >= 40 && parsed.bpm <= 220 ? parsed.bpm : 100,
    genre: typeof parsed.genre === 'string' ? parsed.genre : (genre || ''),
    niveau,
    sections,
    chord_count: allChords.length,
  });
}
