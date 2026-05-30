// ─── GET /api/eleves/:slug/repertoire ────────────────────────────
// Lecture publique (pas d'auth) du répertoire d'un élève.
// Réponse : { ok, morceaux: [...] } trié createdAt desc.
// L'élève archivé reste accessible (pas de filtre).

import { CORS_PUBLIC } from '../../_lib/cors.js';
import { isValidSlug, readRepertoire } from '../../_lib/repertoire.js';

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
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'invalid_slug' }, 400);

  const morceaux = await readRepertoire(env, slug);
  return jsonResponse({ ok: true, morceaux });
}
