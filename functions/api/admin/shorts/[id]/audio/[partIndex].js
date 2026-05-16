// ─── GET /api/admin/shorts/:id/audio/:partIndex ──────────────────
// Stream l'audio R2 d'une partie d'un extract Shorts.
// Support Range request (HTTP 206) — critique pour audio.currentTime.
//
// Auth admin (cookie mh_admin_pw).

import { requireAdminPassword } from '../../../../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function errorResponse(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return errorResponse('unauthorized', 401);
  if (!env.MASTERHUB_HISTORY) return errorResponse('kv_not_bound', 500);
  if (!env.ANALYSE_R2) return errorResponse('r2_not_bound', 500);

  const id = String(params?.id || '');
  const partIndex = parseInt(String(params?.partIndex || '-1'), 10);
  if (!isValidId(id)) return errorResponse('bad_id', 400);
  if (!Number.isInteger(partIndex) || partIndex < 0) return errorResponse('bad_part_index', 400);

  const record = await env.MASTERHUB_HISTORY.get(`shorts:${id}`, { type: 'json' });
  if (!record) return errorResponse('not_found', 404);
  const parts = Array.isArray(record.parts) ? record.parts : [];
  const part = parts[partIndex];
  if (!part) return errorResponse('part_not_found', 404);
  if (!part.r2Key) return errorResponse('r2_key_missing', 404);

  const mimeType = part.mimeType || 'audio/mpeg';
  const baseHeaders = {
    ...CORS,
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  // Range parsing
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': 'bytes */*' },
      });
    }
    const start = parseInt(m[1], 10);
    const endSpec = m[2] !== '';
    const endParsed = endSpec ? parseInt(m[2], 10) : null;
    const length = endParsed !== null ? Math.max(0, endParsed - start + 1) : undefined;

    let r2Object;
    try {
      r2Object = await env.ANALYSE_R2.get(part.r2Key, {
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

  // Full body
  let r2Object;
  try {
    r2Object = await env.ANALYSE_R2.get(part.r2Key);
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
