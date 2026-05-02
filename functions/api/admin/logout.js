// ─── POST /api/admin/logout ──────────────────────────────────────
// Efface le cookie mh_admin_pw côté navigateur (Max-Age=0). Pas de KV à
// nettoyer (cookie stateless HMAC).

import { buildAdminPasswordClearCookie } from '../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Set-Cookie': buildAdminPasswordClearCookie(),
    },
  });
}
