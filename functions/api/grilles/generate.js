// ─── POST /api/grilles/generate ────────────────────────────────────
// Génère 5 progressions harmoniques cohérentes mettant en avant les types
// d'accords sélectionnés par l'élève. Appel direct Groq Llama 3.3 70B.
//
// Body : { types: ['min7','7','maj7'] }
//   - 1+ types depuis MhTheory (whitelist 22 entries)
//   - Pas d'auth (page élève publique avec slug whitelist côté frontend)
//
// Response : { ok: true, progressions: [{ key, key_label_fr, chords[], degrees[] }] }
//   - 5 progressions max, 4 ou 8 accords chacune
//   - Tonalités différentes parmi les 24 (12 majeures + 12 mineures)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_TYPES = [
  'maj','min','dim','aug','sus2','sus4',
  '7','maj7','min7','min7b5','dim7','mMaj7',
  '6','min6','add9','9','13','min11',
  '7sus4','7b9','7#5','7#9'
];

// Niveau de complexité par type (1 = triade simple, 4 = altéré/extension).
// Le ceiling de la palette d'une grille = max(level) des types cochés.
const TYPE_LEVELS = {
  // Niveau 1 — Triades simples
  'maj': 1, 'min': 1, 'dim': 1, 'aug': 1, 'sus2': 1, 'sus4': 1,
  // Niveau 2 — Septièmes
  '7': 2, 'maj7': 2, 'min7': 2, 'min7b5': 2, 'dim7': 2, 'mMaj7': 2,
  // Niveau 3 — Sixtes + ajouts
  '6': 3, 'min6': 3, 'add9': 3,
  // Niveau 4 — Extensions et altérées
  '9': 4, '13': 4, 'min11': 4, '7sus4': 4, '7b9': 4, '7#5': 4, '7#9': 4
};

// Mapping id MhTheory → suffixe LLM (notation jazz standard).
// Le LLM utilise "m7" et non "min7" ; on mappe pour la palette.
const TYPE_TO_LLM_SUFFIX = {
  'maj':    'maj (ou rien)',
  'min':    'm',
  'dim':    'dim',
  'aug':    'aug',
  'sus2':   'sus2',
  'sus4':   'sus4',
  '7':      '7',
  'maj7':   'maj7',
  'min7':   'm7',
  'min7b5': 'm7b5',
  'dim7':   'dim7',
  'mMaj7':  'mMaj7',
  '6':      '6',
  'min6':   'm6',
  'add9':   'add9',
  '9':      '9',
  '13':     '13',
  'min11':  'm11',
  '7sus4':  '7sus4',
  '7b9':    '7b9',
  '7#5':    '7#5',
  '7#9':    '7#9'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const types = Array.isArray(body.types) ? body.types : [];
  // Minimum 2 types pour garantir la variété pédagogique de la grille.
  if (types.length < 2 || types.length > 22) {
    return json({ error: 'invalid_types_count' }, 400);
  }
  if (!types.every(t => VALID_TYPES.includes(t))) {
    return json({ error: 'unknown_type' }, 400);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: 'groq_not_configured' }, 500);
  }

  // Ceiling de complexité : le niveau le plus élevé parmi les types cochés.
  // La palette autorisée pour la grille = tous les types ≤ ce niveau.
  const maxLevel = Math.max(...types.map(t => TYPE_LEVELS[t] || 1));
  const allowedTypes = VALID_TYPES.filter(t => TYPE_LEVELS[t] <= maxLevel);
  const allowedSuffixes = allowedTypes.map(t => TYPE_TO_LLM_SUFFIX[t]).join(', ');

  const systemPrompt = `Tu es un expert en harmonie musicale (jazz, gospel, pop). Tu réponds UNIQUEMENT en JSON pur valide, sans markdown ni texte autour.`;

  const userPrompt = `L'élève veut travailler les types d'accords suivants : ${types.join(', ')}.
Niveau de complexité maximum de la sélection : ${maxLevel} sur 4.

Génère exactement 5 progressions d'accords cohérentes harmoniquement qui mettent en avant ces types.

═══ PALETTE D'ACCORDS AUTORISÉE (CEILING DE COMPLEXITÉ) ═══

Tu DOIS UNIQUEMENT utiliser des accords avec ces suffixes (après la racine [A-G] avec # ou b optionnel) :

${allowedSuffixes}

INTERDIT FORMELLEMENT : tout autre suffixe en dehors de cette palette.
Cette règle est PRIORITAIRE sur tout le reste : pas un seul accord ne doit utiliser un suffixe hors palette.

Pourquoi : l'élève travaille des types simples ou intermédiaires ; lui infliger un 7#9 ou un 13 hors palette serait pédagogiquement incohérent. Reste dans le niveau ≤ ${maxLevel}.

═══ CONTRAINTES OBLIGATOIRES ═══

1. DISTRIBUTION LONGUEUR — sur les 5 progressions :
   - EXACTEMENT 2 ou 3 progressions à 4 accords
   - EXACTEMENT 2 ou 3 progressions à 8 accords
   - Total = 5 (donc soit 2+3 soit 3+2)
   - INTERDIT : 5×4, 5×8, 1×4+4×8, 4×4+1×8 (toute autre distribution est REJETÉE)

2. DIVERSITÉ DES ARMURES — les 5 tonalités doivent être DIFFÉRENTES, et :
   - AU MOINS 1 tonalité avec armure simple (0-2 altérations) : C, G, F, D, Bb, Am, Em, Dm
   - AU MOINS 1 tonalité avec armure intermédiaire (3-4 altérations) : E, A, Eb, Ab, F#m, C#m, Gm, Cm
   - Si possible (recommandé non obligatoire) : une tonalité avec 5+ altérations (B, F#, Db, Gb, G#m, Bbm)
   - INTERDIT : 5 tonalités toutes avec ≤ 2 altérations

3. PROGRESSIONS À 8 ACCORDS — INTERDICTION DE RÉPÉTER UNE CADENCE COURTE :
   - INTERDIT : 2× la même cadence (ex: ii-V-I-vi-ii-V-I-vi, ou I-vi-ii-V-I-vi-ii-V)
   - REQUIS : suite étendue inédite. Exemples valables :
     • Turnaround complet I-vi-ii-V-iii-VI-ii-V
     • Modulation vers le relatif majeur/mineur (ex: en Cmaj → passage par Am en milieu)
     • Montée chromatique (ex: I-#I°-ii-#ii°-iii-V/V-V-I)
     • Multi-degrés idiomatique (ex: I-IV-iii-vi-ii-V-I-IV en jazz/gospel)
     • Cycle de quintes (ex: vi-ii-V-I-IV-vii°-iii-vi)
   - Chaque accord de la suite de 8 doit avoir une fonction harmonique justifiée par les degrés

4. TYPES DEMANDÉS — chaque progression DOIT contenir AU MOINS 2 occurrences (positions différentes dans la grille) des types choisis par l'élève (${types.join(', ')}), intégrées idiomatiquement.

5. STYLE — jazz, gospel, pop, bossa, ou modal. JAMAIS atonal ni aléatoire.

═══ AUTRES INTERDITS DE NOTATION ═══

NE JAMAIS utiliser : ø (écris m7b5 si dans la palette), Δ (écris maj7 si dans la palette), m9, m13, 11, accords slash type C/E.

═══ FORMAT JSON STRICT ═══

{
  "progressions": [
    {
      "key": "Eb major",
      "key_label_fr": "Mi♭ majeur",
      "chords": ["Fm7", "Bb7", "Ebmaj7", "Cm7"],
      "degrees": ["ii", "V", "I", "vi"]
    }
  ]
}

- Tonalités mineures : "G minor" / "Sol mineur"
- Degrés en chiffres romains : "I","ii","iii","IV","V","vi","vii°" (majuscule = majeur, minuscule = mineur, ° = diminué)
- Pour les emprunts/secondaires : "V/V","V/ii","#iv°","bVII"
- EXACTEMENT 5 progressions dans le tableau, aucune de plus, aucune de moins.`;

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 1800,
        response_format: { type: 'json_object' }
      })
    });
  } catch (e) {
    console.error('[grilles/generate] fetch failed:', e?.message);
    return json({ error: 'groq_unreachable' }, 502);
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => '');
    console.error('[grilles/generate] Groq HTTP', groqRes.status, errText.slice(0, 200));
    return json({ error: 'groq_failed', status: groqRes.status }, 502);
  }

  let groqData;
  try {
    groqData = await groqRes.json();
  } catch {
    return json({ error: 'invalid_groq_response' }, 502);
  }

  const text = groqData?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[grilles/generate] JSON parse failed, raw:', text.slice(0, 300));
    return json({ error: 'invalid_llm_output' }, 502);
  }

  if (!parsed || !Array.isArray(parsed.progressions) || parsed.progressions.length === 0) {
    return json({ error: 'invalid_structure' }, 502);
  }

  // Sanity filter : chaque prog doit avoir key string + chords[] (≥4) + degrees[]
  const valid = parsed.progressions.filter(p =>
    p && typeof p.key === 'string'
      && Array.isArray(p.chords) && p.chords.length >= 4
      && Array.isArray(p.degrees)
      && p.chords.every(c => typeof c === 'string' && c.trim().length > 0)
  );

  if (valid.length === 0) {
    return json({ error: 'no_valid_progression' }, 502);
  }

  return json({ ok: true, progressions: valid.slice(0, 5) }, 200);
}
