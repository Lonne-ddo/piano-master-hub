// ─── GET /api/eleves/:slug/repertoire/:id ────────────────────────
// Lecture publique (pas d'auth) d'un morceau précis du répertoire.
// Réponse : { ok, morceau } ou 404.

import { CORS_PUBLIC } from '../../../_lib/cors.js';
import { isValidSlug, readRepertoire } from '../../../_lib/repertoire.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_PUBLIC, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_PUBLIC });
}

export async function onRequestGet({ params, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  const id = String(params?.id || '');
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'invalid_slug' }, 400);

  const morceaux = await readRepertoire(env, slug);
  const morceau = morceaux.find((m) => m && m.id === id);
  if (!morceau) return jsonResponse({ error: 'not_found' }, 404);

  return jsonResponse({ ok: true, morceau });
}
