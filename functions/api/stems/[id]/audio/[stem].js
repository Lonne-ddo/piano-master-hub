// ─── GET /api/stems/:id/audio/:stem ─────────────────────────────
// Proxy audio R2. Stream le fichier audio d'une séparation, avec auth :
//   - admin (cookie mh_admin_pw)               → tous les stems autorisés
//   - élève (cookie mh_session.slug ∈ assignedTo) → ses propres stems
//
// Supporte les Range requests (HTTP 206) pour permettre le seek dans <audio>.
// Headers : Content-Type audio/mpeg, Cache-Control private max-age=3600.

import { requireAdminPassword, getSessionFromRequest } from '../../../_lib/session.js';

const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];

function plainResponse(text, status, headers = {}) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}

function isValidSeparationId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

async function findEntry(env, separationId) {
  const ts = parseInt(separationId.split('-')[0], 10);
  if (!Number.isFinite(ts)) return null;
  const date = new Date(ts);
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const key = `stems:${ym}:${separationId}`;
  try {
    const entry = await env.MASTERHUB_HISTORY.get(key, { type: 'json' });
    return entry || null;
  } catch { return null; }
}

export async function onRequestGet({ params, request, env }) {
  if (!env.STEMS_R2) return plainResponse('r2_not_bound', 500);
  if (!env.MASTERHUB_HISTORY) return plainResponse('kv_not_bound', 500);

  const id = String(params?.id || '');
  const stem = String(params?.stem || '').toLowerCase();
  if (!isValidSeparationId(id)) return plainResponse('bad_id', 400);
  if (!STEM_KEYS.includes(stem)) return plainResponse('bad_stem', 400);

  const entry = await findEntry(env, id);
  if (!entry || entry.status !== 'success') return plainResponse('not_found', 404);

  // Auth : admin OR élève dans assignedTo
  let authorized = false;
  if (await requireAdminPassword(request, env)) {
    authorized = true;
  } else {
    const session = await getSessionFromRequest(request, env);
    const assigned = Array.isArray(entry.assignedTo) ? entry.assignedTo : [];
    if (session?.slug && assigned.includes(session.slug)) {
      authorized = true;
    }
  }
  if (!authorized) return plainResponse('unauthorized', 401);

  const r2Key = entry.r2Keys?.[stem];
  if (!r2Key) return plainResponse('stem_not_available', 404);

  // Range request support : "bytes=start-end" (end optionnel)
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
    if (!m) return plainResponse('bad_range', 416);
    const offset = parseInt(m[1], 10);
    const endSpecified = m[2] != null;
    const end = endSpecified ? parseInt(m[2], 10) : null;
    const length = end !== null ? Math.max(0, end - offset + 1) : undefined;

    let r2Object;
    try {
      r2Object = await env.STEMS_R2.get(r2Key, {
        range: length !== undefined ? { offset, length } : { offset },
      });
    } catch (e) {
      return plainResponse('r2_get_failed', 500);
    }
    if (!r2Object) return plainResponse('not_found', 404);

    const totalSize = r2Object.size;
    const realEnd = end !== null ? Math.min(end, totalSize - 1) : totalSize - 1;
    const headers = new Headers();
    headers.set('Content-Type', 'audio/mpeg');
    headers.set('Content-Range', `bytes ${offset}-${realEnd}/${totalSize}`);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(realEnd - offset + 1));
    headers.set('Cache-Control', 'private, max-age=3600');
    return new Response(r2Object.body, { status: 206, headers });
  }

  let r2Object;
  try {
    r2Object = await env.STEMS_R2.get(r2Key);
  } catch (e) {
    return plainResponse('r2_get_failed', 500);
  }
  if (!r2Object) return plainResponse('not_found', 404);

  const headers = new Headers();
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Content-Length', String(r2Object.size));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(r2Object.body, { status: 200, headers });
}
