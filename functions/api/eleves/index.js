// ─── GET /api/eleves ─────────────────────────────────────────────
// Source de vérité unique pour la liste des élèves (slugs).
// Lecture KV `eleves:list`. Si absente, bootstrap avec la liste par défaut
// (4 élèves originaux) puis retourne avec source: 'seeded'.
// Public — pas d'auth (consommé par /admin/ pour les onglets et /index.html
// pour la whitelist côté élève).
//
// Réponse : { ok: true, eleves: ['japhet','messon','dexter','tara'], source: 'kv'|'seeded'|'fallback' }

const DEFAULT_ELEVES = ['japhet', 'messon', 'dexter', 'tara'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  try {
    const raw = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (Array.isArray(raw) && raw.length > 0) {
      const cleaned = raw.map(s => String(s).toLowerCase()).filter(Boolean);
      return jsonResponse({ ok: true, eleves: cleaned, source: 'kv' });
    }
    // Bootstrap : seed la clé eleves:list avec la liste par défaut (idempotent)
    await env.MASTERHUB_STUDENTS.put('eleves:list', JSON.stringify(DEFAULT_ELEVES));
    return jsonResponse({ ok: true, eleves: DEFAULT_ELEVES, source: 'seeded' });
  } catch (e) {
    // KV down ou erreur de parse : fallback gracieux sans persistance
    return jsonResponse({ ok: true, eleves: DEFAULT_ELEVES, source: 'fallback', error: e?.message || '' });
  }
}
