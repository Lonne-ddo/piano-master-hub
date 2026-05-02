// ─── GET /api/auth/whoami ────────────────────────────────────────
// Retourne { ok: true, slug, email } si cookie mh_session valide, sinon 401.
// Utilisé par /index.html pour décider entre "écran login" et "redirect /{slug}"
// quand l'URL ne contient pas de slug.

import { getSessionFromRequest } from '../_lib/session.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request, env }) {
  const session = await getSessionFromRequest(request, env);
  if (!session || !session.slug) {
    return jsonResponse({ ok: false }, 401);
  }
  return jsonResponse({ ok: true, slug: session.slug, email: session.email || null });
}
