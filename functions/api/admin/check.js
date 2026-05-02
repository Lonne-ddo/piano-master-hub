// ─── GET /api/admin/check ────────────────────────────────────────
// Lit le cookie mh_admin_pw, vérifie expiration + signature HMAC.
// Utilisé par les pages /admin/*.html pour décider d'afficher la page
// ou rediriger vers /admin/login.html.
//
// Réponse : { ok: true } si cookie valide, sinon 401 { ok: false }.

import { requireAdminPassword } from '../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const ok = await requireAdminPassword(request, env);
  return jsonResponse({ ok }, ok ? 200 : 401);
}
