// ─── GET /api/stems/status?id=<prediction_id> ────────────────────
// Poll l'état d'une prédiction Replicate (succeeded / failed / canceled / processing).
// Auth super-admin (session cookie OU x-admin-secret).

import { getSessionFromRequest } from '../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function requireAdmin(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (session?.is_admin) return true;

  const secret = request.headers.get('x-admin-secret');
  return !!(secret && env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.REPLICATE_API_TOKEN) {
    return jsonResponse({ error: 'REPLICATE_API_TOKEN missing' }, 500);
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(id) || id.length > 64) {
    return jsonResponse({ error: 'Paramètre "id" invalide' }, 400);
  }

  const resp = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
  });
  const data = await resp.json();
  return jsonResponse(data, resp.status);
}
