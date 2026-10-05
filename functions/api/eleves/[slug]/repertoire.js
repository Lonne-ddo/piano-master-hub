// ─── GET /api/eleves/:slug/repertoire ────────────────────────────
// Lecture réservée à l'élève concerné (session) ou à l'admin.
// Réponse : { ok, morceaux: [...] } trié createdAt desc.
// L'élève archivé reste accessible (pas de filtre).

import { CORS_PUBLIC } from '../../_lib/cors.js';
import { isValidSlug, readRepertoire } from '../../_lib/repertoire.js';
import { requireEleveOrAdmin } from '../../_lib/session.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_PUBLIC, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_PUBLIC });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'invalid_slug' }, 400);

  const morceaux = await readRepertoire(env, slug);
  return jsonResponse({ ok: true, morceaux });
}
