// ─── /api/admin/shorts/:id ───────────────────────────────────────
// GET    : retourne le record complet (passages + transcripts)
// DELETE : supprime le record KV
// Auth admin.

import { requireAdminPassword } from '../../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
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
  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  let record;
  try {
    record = await env.MASTERHUB_HISTORY.get(`shorts:${id}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_get_failed', detail: e?.message || '' }, 500);
  }
  if (!record) return jsonResponse({ error: 'not_found' }, 404);

  return jsonResponse({ ok: true, record });
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  try {
    await env.MASTERHUB_HISTORY.delete(`shorts:${id}`);
  } catch (e) {
    return jsonResponse({ error: 'kv_delete_failed', detail: e?.message || '' }, 500);
  }
  return jsonResponse({ ok: true, id });
}
