// ─── /api/analyse/:id ────────────────────────────────────────────
// PATCH  → rename ou réassigner (admin only)
// DELETE → supprime KV + R2 (original + stems si multitrack, admin only)

import { requireAdminPassword } from '../_lib/session.js';
import { isValidId, loadValidSlugs, CORS, jsonResponse } from './_helpers.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function loadRecord(env, id) {
  try {
    return await env.MASTERHUB_ANALYSE.get(`analyse:${id}`, { type: 'json' });
  } catch {
    return null;
  }
}

export async function onRequestPatch({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const record = await loadRecord(env, id);
  if (!record) return jsonResponse({ error: 'not_found' }, 404);

  const updated = { ...record };

  // ── title ──
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return jsonResponse({ error: 'title_invalid' }, 400);
    const cleaned = body.title.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (cleaned.length < 1 || cleaned.length > 200) {
      return jsonResponse({ error: 'title_invalid', detail: 'requis 1-200 chars' }, 400);
    }
    updated.title = cleaned;
  }

  // ── assignedTo ──
  if (body.assignedTo !== undefined) {
    let raw;
    if (body.assignedTo === null) raw = [];
    else if (typeof body.assignedTo === 'string') raw = body.assignedTo ? [body.assignedTo] : [];
    else if (Array.isArray(body.assignedTo)) raw = body.assignedTo;
    else return jsonResponse({ error: 'assignedTo_invalid' }, 400);

    const validSlugs = await loadValidSlugs(env);
    const cleanSlugs = Array.from(new Set(
      raw
        .filter((s) => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => validSlugs.includes(s)),
    ));
    updated.assignedTo = cleanSlugs;
  }

  try {
    await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(updated));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({
    ok: true,
    id,
    title: updated.title,
    assignedTo: updated.assignedTo,
  });
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.ANALYSE_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const record = await loadRecord(env, id);
  if (!record) return jsonResponse({ error: 'not_found' }, 404);

  // 1) Delete R2 original (best-effort)
  if (record.r2KeyOriginal) {
    try { await env.ANALYSE_R2.delete(record.r2KeyOriginal); }
    catch (e) { console.warn('[analyse] R2 original delete failed', e?.message || e); }
  }

  // 2) Delete R2 stems si multitrack (best-effort, parallèle)
  if (record.r2KeysStems && typeof record.r2KeysStems === 'object') {
    await Promise.all(Object.values(record.r2KeysStems).map(async (key) => {
      if (typeof key !== 'string') return;
      try { await env.ANALYSE_R2.delete(key); }
      catch (e) { console.warn('[analyse] R2 stem delete failed', key, e?.message || e); }
    }));
  }

  // 3) Delete KV
  try {
    await env.MASTERHUB_ANALYSE.delete(`analyse:${id}`);
  } catch (e) {
    return jsonResponse({ error: 'kv_delete_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, id });
}
