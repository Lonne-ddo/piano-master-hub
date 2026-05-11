// ─── GET /api/analyse/:id/stream/:track ──────────────────────────
// Stream une stem multitrack (vocals | drums | bass | piano | guitar | other).
// Auth : admin OU élève assigné (assignedTo.includes(slug)).
// 404 si type='single' ou track absent du record.r2KeysStems.
//
// Support Range (HTTP 206) pour seek fluide.

import { requireAdminPassword, getSessionFromRequest } from '../../../_lib/session.js';
import { isValidId, STEM_KEYS, CORS } from '../../_helpers.js';

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
  const track = String(params?.track || '').toLowerCase();
  if (!isValidId(id)) return errorResponse('bad_id', 400);
  if (!STEM_KEYS.includes(track)) return errorResponse('bad_track', 400);

  const record = await env.MASTERHUB_ANALYSE.get(`analyse:${id}`, { type: 'json' });
  if (!record) return errorResponse('not_found', 404);
  if (record.type !== 'multitrack') return errorResponse('not_multitrack', 404);

  const r2Key = record.r2KeysStems?.[track];
  if (!r2Key) return errorResponse('track_not_found', 404);

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
  const baseHeaders = {
    ...STREAM_CORS,
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': 'bytes */*' },
      });
    }
    const start = parseInt(m[1], 10);
    const endSpecified = m[2] !== '';
    const endParsed = endSpecified ? parseInt(m[2], 10) : null;
    const length = endParsed !== null ? Math.max(0, endParsed - start + 1) : undefined;

    let r2Object;
    try {
      r2Object = await env.ANALYSE_R2.get(r2Key, {
        range: length !== undefined ? { offset: start, length } : { offset: start },
      });
    } catch (e) {
      return errorResponse('r2_get_failed', 500);
    }
    if (!r2Object) return errorResponse('r2_object_missing', 404);

    const totalSize = r2Object.size;
    const realEnd = endParsed !== null ? Math.min(endParsed, totalSize - 1) : totalSize - 1;
    return new Response(r2Object.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(realEnd - start + 1),
        'Content-Range': `bytes ${start}-${realEnd}/${totalSize}`,
      },
    });
  }

  let r2Object;
  try {
    r2Object = await env.ANALYSE_R2.get(r2Key);
  } catch (e) {
    return errorResponse('r2_get_failed', 500);
  }
  if (!r2Object) return errorResponse('r2_object_missing', 404);

  return new Response(r2Object.body, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(r2Object.size || 0),
    },
  });
}
