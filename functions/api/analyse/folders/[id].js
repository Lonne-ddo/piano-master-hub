// ─── /api/analyse/folders/:id ────────────────────────────────────
// Admin uniquement (cookie mh_admin_pw).
// PATCH  → body { name?, order? } : renommer et/ou déplacer (order = position
//          cible 0..n-1, les autres dossiers se décalent).
// DELETE → supprime le dossier ; ses morceaux repassent « Sans dossier »
//          (aucun morceau supprimé).

import { requireAdminPassword } from '../../_lib/session.js';
import { CORS, jsonResponse } from '../_helpers.js';
import { loadFolders, saveFolders, sortFolders, cleanFolderName, isValidFolderId } from '../_folders.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPatch({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidFolderId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const folders = sortFolders(await loadFolders(env));
  const idx = folders.findIndex((f) => f.id === id);
  if (idx === -1) return jsonResponse({ error: 'not_found' }, 404);

  if (body?.name !== undefined) {
    const { name, error, detail } = cleanFolderName(body.name, folders, id);
    if (error) return jsonResponse({ error, detail }, error === 'name_taken' ? 409 : 400);
    folders[idx] = { ...folders[idx], name };
  }

  if (body?.order !== undefined) {
    const target = Number(body.order);
    if (!Number.isInteger(target)) return jsonResponse({ error: 'order_invalid' }, 400);
    const [moved] = folders.splice(idx, 1);
    folders.splice(Math.max(0, Math.min(folders.length, target)), 0, moved);
  }

  try {
    const saved = await saveFolders(env, folders);
    return jsonResponse({ ok: true, folder: saved.find((f) => f.id === id), folders: saved });
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidFolderId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const folders = sortFolders(await loadFolders(env));
  if (!folders.some((f) => f.id === id)) return jsonResponse({ error: 'not_found' }, 404);

  // 1) Morceaux du dossier → « Sans dossier » (folderId retiré)
  let moved = 0;
  let cursor;
  try {
    while (true) {
      const page = await env.MASTERHUB_ANALYSE.list({ prefix: 'analyse:', cursor, limit: 1000 });
      const values = await Promise.all(
        page.keys.map((k) => env.MASTERHUB_ANALYSE.get(k.name, { type: 'json' }).catch(() => null)),
      );
      for (const v of values) {
        if (v && v.id && v.folderId === id) {
          const { folderId, ...rest } = v;
          await env.MASTERHUB_ANALYSE.put(`analyse:${v.id}`, JSON.stringify(rest));
          moved++;
        }
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch (e) {
    return jsonResponse({ error: 'kv_update_failed', detail: e?.message || '' }, 500);
  }

  // 2) Dossier retiré de la liste
  try {
    const saved = await saveFolders(env, folders.filter((f) => f.id !== id));
    return jsonResponse({ ok: true, id, moved, folders: saved });
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }
}
