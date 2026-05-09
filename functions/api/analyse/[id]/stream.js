// ─── GET /api/analyse/:id/stream ─────────────────────────────────
// Sert la vidéo R2 avec support Range (essentiel pour seek fluide).
// Auth : admin OU élève assigné (assignedTo.includes(slug)).
//
// Response :
//   - 200 (full body) si pas de header Range
//   - 206 Partial Content si Range parsable, avec Content-Range
//   - 416 Range Not Satisfiable si Range out-of-bounds

import { requireAdminPassword, getSessionFromRequest } from '../../_lib/session.js';
import { isValidId, CORS } from '../_helpers.js';

const STREAM_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function errorResponse(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...STREAM_CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: STREAM_CORS });
}

export async function onRequestGet({ params, request, env }) {
  if (!env.MASTERHUB_ANALYSE) return errorResponse('kv_not_bound', 500);
  if (!env.ANALYSE_R2) return errorResponse('r2_not_bound', 500);

  const id = String(params?.id || '');
  if (!isValidId(id)) return errorResponse('bad_id', 400);

  const record = await env.MASTERHUB_ANALYSE.get(`analyse:${id}`, { type: 'json' });
  if (!record || !record.r2Key) return errorResponse('not_found', 404);

  // ── Auth : admin OU élève assigné ──
  const isAdmin = await requireAdminPassword(request, env);
  if (!isAdmin) {
    const session = await getSessionFromRequest(request, env);
    if (!session?.slug) return errorResponse('unauthorized', 401);
    const assigned = Array.isArray(record.assignedTo) ? record.assignedTo : [];
    if (!assigned.includes(session.slug)) return errorResponse('forbidden', 403);
  }

  // ── Range parsing ──
  const rangeHeader = request.headers.get('Range');
  let r2Object;

  const total = record.sizeBytes || 0;
  const baseHeaders = {
    ...STREAM_CORS,
    'Content-Type': record.mimeType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (rangeHeader) {
    // Parse "bytes=START-END" (END optionnel)
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
      });
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : (total > 0 ? total - 1 : 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || (total > 0 && start >= total) || end < start) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
      });
    }
    const length = end - start + 1;

    try {
      r2Object = await env.ANALYSE_R2.get(record.r2Key, {
        range: { offset: start, length },
      });
    } catch (e) {
      return errorResponse('r2_get_failed', 500);
    }
    if (!r2Object) return errorResponse('r2_object_missing', 404);

    return new Response(r2Object.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${total || '*'}`,
      },
    });
  }

  // Pas de Range → full body
  try {
    r2Object = await env.ANALYSE_R2.get(record.r2Key);
  } catch (e) {
    return errorResponse('r2_get_failed', 500);
  }
  if (!r2Object) return errorResponse('r2_object_missing', 404);

  return new Response(r2Object.body, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(total || r2Object.size || 0),
    },
  });
}
