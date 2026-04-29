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
  if (types.length === 0 || types.length > 22) {
    return json({ error: 'invalid_types_count' }, 400);
  }
  if (!types.every(t => VALID_TYPES.includes(t))) {
    return json({ error: 'unknown_type' }, 400);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: 'groq_not_configured' }, 500);
  }

  const systemPrompt = `Tu es un expert en harmonie musicale (jazz, gospel, pop). Tu réponds UNIQUEMENT en JSON pur valide, sans markdown ni texte autour.`;

  const userPrompt = `L'élève veut travailler les types d'accords suivants : ${types.join(', ')}.

Génère exactement 5 progressions d'accords cohérentes harmoniquement qui mettent en avant ces types.

Règles strictes :
- Chaque progression dans une tonalité DIFFÉRENTE, choisie parmi les 24 tonalités (12 majeures + 12 mineures)
- 4 ou 8 accords par progression (privilégier 8 si la cadence en bénéficie type ii-V-I-vi-ii-V-I-IV ; sinon 4)
- Inclure au moins 2 occurrences (positions différentes) des types demandés, intégrées dans une progression diatonique idiomatique
- Style jazz/gospel/pop cohérent (pas atonal aléatoire)

Notation OBLIGATOIRE — utilise UNIQUEMENT ces suffixes après la racine ([A-G] avec # ou b optionnel) :
maj (ou rien), m, dim, aug, sus2, sus4, 7, maj7, m7, m7b5, dim7, mMaj7, 6, m6, add9, 9, 13, m11, 7sus4, 7b9, 7#5, 7#9

NE PAS utiliser : ø (écris m7b5), Δ (écris maj7), m9, m13, 11, accords slash type C/E.

Format JSON strict :
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

Tonalités mineures : "G minor" / "Sol mineur". Les degrés en chiffres romains ("I","ii","iii","IV","V","vi","vii°"). Réponds avec exactement 5 progressions.`;

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
