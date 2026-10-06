// ─── /api/analyse/folders ────────────────────────────────────────
// Admin uniquement (cookie mh_admin_pw).
// GET  → { ok, folders: [{ id, name, order, createdAt }] } (ordre du coach)
// POST → body { name } → 201 { ok, folder, folders } | 400 name_invalid | 409 name_taken

import { requireAdminPassword } from '../../_lib/session.js';
import { CORS, jsonResponse, genId } from '../_helpers.js';
import { loadFolders, saveFolders, sortFolders, cleanFolderName } from '../_folders.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);
  return jsonResponse({ ok: true, folders: sortFolders(await loadFolders(env)) });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const folders = sortFolders(await loadFolders(env));
  const { name, error, detail } = cleanFolderName(body?.name, folders);
  if (error) return jsonResponse({ error, detail }, error === 'name_taken' ? 409 : 400);

  const folder = { id: genId(), name, order: folders.length, createdAt: Date.now() };
  try {
    const saved = await saveFolders(env, [...folders, folder]);
    return jsonResponse({ ok: true, folder: saved[saved.length - 1], folders: saved }, 201);
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }
}
