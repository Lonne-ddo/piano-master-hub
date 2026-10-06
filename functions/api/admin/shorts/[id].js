// ─── /api/admin/shorts/:id ───────────────────────────────────────
// GET    : retourne le record complet (passages + transcripts)
// DELETE : supprime le record KV et l'audio R2 shorts/<id>/*
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

  // Audio R2 des parties (shorts/<id>/part_N.ext) : supprimé avec le record.
  // Un échec ici n'annule pas la suppression (record déjà retiré du KV).
  let r2Deleted = 0;
  if (env.ANALYSE_R2) {
    try {
      // Lister tout avant de supprimer (ne pas paginer sur un préfixe en cours
      // de suppression), puis delete par lots de 1000 (limite R2).
      const keys = [];
      let cursor;
      do {
        const page = await env.ANALYSE_R2.list({ prefix: `shorts/${id}/`, cursor });
        for (const o of page.objects) keys.push(o.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      for (let i = 0; i < keys.length; i += 1000) {
        await env.ANALYSE_R2.delete(keys.slice(i, i + 1000));
      }
      r2Deleted = keys.length;
    } catch (e) {
      console.warn('[shorts] R2 cleanup failed', id, e?.message || e);
    }
  }
  return jsonResponse({ ok: true, id, r2Deleted });
}
