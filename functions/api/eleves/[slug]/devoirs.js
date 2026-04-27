// ─── GET /api/eleves/{slug}/devoirs ─────────────────────────────
// Endpoint PUBLIC (pas d'auth admin) consommé par /devoirs.html côté élève.
// Retourne UNIQUEMENT 2 champs (date + devoirs) — pas de doc Drive, pas de
// notes admin, pas de Telegram, pas de répertoire, pas de transcript.
// Whitelist stricte des 4 slugs autorisés.

const VALID_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ params, env }) {
  const slug = String(params.slug || '').toLowerCase();
  if (!VALID_SLUGS.includes(slug)) {
    return jsonResponse({ error: 'invalid' }, 400);
  }

  let data = null;
  try {
    data = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_error', details: e?.message || '' }, 500);
  }

  if (!data) {
    return jsonResponse({ devoirs: null, date: null });
  }

  // Filtrage strict : ne renvoie QUE les 2 champs publics
  const devoirs = Array.isArray(data?.derniere_seance?.devoirs)
    ? data.derniere_seance.devoirs.filter(Boolean).map(String)
    : null;
  const date = data?.derniere_seance?.date || null;

  return jsonResponse({ devoirs, date });
}
