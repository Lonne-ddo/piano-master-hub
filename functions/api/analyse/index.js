// ─── GET /api/analyse ────────────────────────────────────────────
// Liste tous les records analyse (admin only), tri uploadedAt desc.
// Mix type='single' + type='multitrack' (status pending/success/failed).

import { requireAdminPassword } from '../_lib/session.js';
import { CORS, jsonResponse } from './_helpers.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
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
      if (v && v.id) {
        items.push({
          id: v.id,
          title: v.title || 'Sans titre',
          type: v.type || 'single',
          status: v.status || 'success',
          mimeType: v.mimeType || '',
          sizeBytes: v.sizeBytes || 0,
          durationSeconds: v.durationSeconds || 0,
          assignedTo: Array.isArray(v.assignedTo) ? v.assignedTo : [],
          uploadedAt: v.uploadedAt || 0,
          originalFilename: v.originalFilename || '',
          // multitrack-only fields (présents seulement si applicable)
          stems: (v.r2KeysStems && typeof v.r2KeysStems === 'object')
            ? Object.keys(v.r2KeysStems)
            : [],
          replicateId: v.replicateId || null,
          costEUR: v.costEUR || 0,
          errorCode: v.errorCode || null,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  items.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return jsonResponse({ ok: true, items });
}
