// ─── GET /api/analyse/:id/stream ─────────────────────────────────
// Sert l'audio R2 original (r2KeyOriginal) avec support Range.
// Auth : admin OU élève assigné (assignedTo.includes(slug)).
//
// Pour les stems multitrack, voir /api/analyse/:id/stream/:track.
//
// Response :
//   - 200 (full body) si pas de header Range
//   - 206 Partial Content si Range parsable, avec Content-Range
//   - 416 Range Not Satisfiable si Range out-of-bounds

import { requireAdminPassword, getSessionFromRequest, verifyReplicateToken } from '../../_lib/session.js';
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
  // r2KeyOriginal (nouveau schéma) avec fallback r2Key (legacy migration douce).
  const r2KeyOrig = record?.r2KeyOriginal || record?.r2Key;
  if (!record || !r2KeyOrig) return errorResponse('not_found', 404);

  // ── Auth : token Replicate signé (one-shot) OU admin OU élève assigné ──
  // Replicate télécharge l'original via ?t=<token> sans cookie : on accepte
  // un token HMAC court et valide pour cet id, sinon on retombe sur l'auth
  // admin/élève habituelle.
  const tokenParam = new URL(request.url).searchParams.get('t');
  const tokenOk = tokenParam ? await verifyReplicateToken(env, id, tokenParam) : false;
  if (!tokenOk) {
    const isAdmin = await requireAdminPassword(request, env);
    if (!isAdmin) {
      const session = await getSessionFromRequest(request, env);
      if (!session?.slug) return errorResponse('unauthorized', 401);
      const assigned = Array.isArray(record.assignedTo) ? record.assignedTo : [];
      if (!assigned.includes(session.slug)) return errorResponse('forbidden', 403);
    }
  }

  // ── Range parsing ──
  const rangeHeader = request.headers.get('Range');
  let r2Object;

  const total = record.sizeBytes || 0;
  const baseHeaders = {
    ...STREAM_CORS,
    'Content-Type': record.mimeType || 'audio/mpeg',
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
      r2Object = await env.ANALYSE_R2.get(r2KeyOrig, {
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
    r2Object = await env.ANALYSE_R2.get(r2KeyOrig);
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
