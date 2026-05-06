// ─── /api/stems/:id ──────────────────────────────────────────────
// Routes admin sur une séparation existante.
//
//   DELETE /api/stems/:id            → supprime entrée KV + objets R2
//   POST   /api/stems/:id?action=assign
//          body { eleveSlugs: ["messon", ...] }
//                                    → met à jour assignedTo
//   PATCH  /api/stems/:id            → renomme (body { title })
//
// Auth admin via cookie mh_admin_pw.
//
// Lookup KV : separationId est de la forme `<ts>-<predIdShort>`. On extrait
// le ym à partir du timestamp pour construire la clé `stems:<ym>:<id>`.

import { requireAdminPassword } from '../_lib/session.js';

const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];
const VALID_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Format separationId : <ts>-<short> (ts = ms epoch). Whitelist stricte.
function isValidSeparationId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

async function findEntry(env, separationId) {
  const ts = parseInt(separationId.split('-')[0], 10);
  if (!Number.isFinite(ts)) return null;
  const date = new Date(ts);
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const key = `stems:${ym}:${separationId}`;
  let entry;
  try {
    entry = await env.MASTERHUB_HISTORY.get(key, { type: 'json' });
  } catch { return null; }
  if (!entry) return null;
  return { entry, key };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.STEMS_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const found = await findEntry(env, id);
  if (!found) return jsonResponse({ error: 'not_found' }, 404);

  // Supprime objets R2 (best-effort, parallèle)
  const r2Keys = found.entry.r2Keys || {};
  await Promise.all(STEM_KEYS.map(async (stem) => {
    if (r2Keys[stem]) {
      try { await env.STEMS_R2.delete(r2Keys[stem]); }
      catch (e) { console.warn('[stems] R2 delete failed', stem, e?.message); }
    }
  }));
  // Supprime aussi le cache waveforms (si calculé)
  try { await env.STEMS_R2.delete(`stems/${id}/waveforms.json`); }
  catch (e) { /* non-bloquant — fichier peut ne pas exister */ }

  // Supprime entrée KV
  try { await env.MASTERHUB_HISTORY.delete(found.key); }
  catch (e) {
    return jsonResponse({ error: 'kv_delete_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, id });
}

export async function onRequestPost({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action !== 'assign') return jsonResponse({ error: 'invalid_action' }, 400);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const rawSlugs = Array.isArray(body?.eleveSlugs) ? body.eleveSlugs : null;
  if (!rawSlugs) return jsonResponse({ error: 'eleveSlugs_required' }, 400);

  // Whitelist stricte + dédup
  const cleanSlugs = Array.from(new Set(
    rawSlugs
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_SLUGS.includes(s)),
  ));

  const found = await findEntry(env, id);
  if (!found) return jsonResponse({ error: 'not_found' }, 404);

  found.entry.assignedTo = cleanSlugs;
  try {
    await env.MASTERHUB_HISTORY.put(found.key, JSON.stringify(found.entry));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, id, assignedTo: cleanSlugs });
}

export async function onRequestPatch({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const raw = typeof body?.title === 'string' ? body.title : null;
  if (raw === null) return jsonResponse({ error: 'title_required' }, 400);

  // Strip ASCII control chars (\x00-\x1F + \x7F) puis trim.
  const title = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (title.length < 1 || title.length > 200) {
    return jsonResponse({ error: 'invalid_length' }, 400);
  }

  const found = await findEntry(env, id);
  if (!found) return jsonResponse({ error: 'not_found' }, 404);

  found.entry.title = title;
  try {
    await env.MASTERHUB_HISTORY.put(found.key, JSON.stringify(found.entry));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, id, title });
}
