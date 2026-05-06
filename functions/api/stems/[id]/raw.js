// ─── GET /api/stems/:id/raw ──────────────────────────────────────
// Endpoint debug admin-only : retourne le record KV brut d'une séparation.
// Sert à diagnostiquer l'output Replicate (champ outputShape) et inspecter
// l'état complet (r2Keys, assignedTo, replicateId, etc.).

import { requireAdminPassword } from '../../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isValidSeparationId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const ts = parseInt(id.split('-')[0], 10);
  if (!Number.isFinite(ts)) return jsonResponse({ error: 'bad_id' }, 400);
  const date = new Date(ts);
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const key = `stems:${ym}:${id}`;

  let entry;
  try {
    entry = await env.MASTERHUB_HISTORY.get(key, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_get_failed', detail: e?.message || '' }, 500);
  }

  if (!entry) return jsonResponse({ error: 'not_found', key }, 404);

  return jsonResponse({ ok: true, key, entry });
}
