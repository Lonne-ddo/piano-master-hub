// ─── GET /api/eleves/:slug/analyse ───────────────────────────────
// Liste les vidéos d'analyse assignées à un élève (assignedTo.includes(slug)).
// Auth : admin OU élève sur sa propre fiche (requireEleveOrAdmin).
//
// Réponse : { ok, items: [{ id, title, durationSeconds, sizeBytes, mimeType,
//                            uploadedAt, streamUrl }] }
// streamUrl = route proxy /api/analyse/:id/stream (auth re-vérifiée à l'appel).

import { requireEleveOrAdmin } from '../../_lib/session.js';

const FALLBACK_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function isValidSlug(slug, env) {
  if (!env.MASTERHUB_STUDENTS) return FALLBACK_SLUGS.includes(slug);
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const valid = Array.isArray(list) && list.length ? list : FALLBACK_SLUGS;
    return valid.includes(slug);
  } catch {
    return FALLBACK_SLUGS.includes(slug);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!await isValidSlug(slug, env)) return jsonResponse({ error: 'invalid_slug' }, 400);

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const items = [];
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_ANALYSE.list({ prefix: 'analyse:', cursor, limit: 1000 });
    } catch (e) {
      return jsonResponse({ error: 'kv_list_failed', detail: e?.message || '' }, 500);
    }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_ANALYSE.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (
        v && v.id && v.r2Key &&
        Array.isArray(v.assignedTo) && v.assignedTo.includes(slug)
      ) {
        items.push({
          id: v.id,
          title: v.title || 'Sans titre',
          durationSeconds: v.durationSeconds || 0,
          sizeBytes: v.sizeBytes || 0,
          mimeType: v.mimeType || 'video/mp4',
          uploadedAt: v.uploadedAt || 0,
          streamUrl: `/api/analyse/${encodeURIComponent(v.id)}/stream`,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  items.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return jsonResponse({ ok: true, items });
}
