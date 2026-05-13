// ─── GET /api/admin/shorts/list ──────────────────────────────────
// Liste les 50 derniers extraits Shorts (KV MASTERHUB_HISTORY prefix shorts:).
// Auth admin.

import { requireAdminPassword } from '../../_lib/session.js';

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const items = [];
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_HISTORY.list({ prefix: 'shorts:', cursor, limit: 1000 });
    } catch (e) {
      return jsonResponse({ error: 'kv_list_failed', detail: e?.message || '' }, 500);
    }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_HISTORY.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (v && v.id) {
        items.push({
          id: v.id,
          title: v.title || 'Sans titre',
          originalFilename: v.originalFilename || '',
          audioDurationMs: v.audioDurationMs || 0,
          passagesCount: Array.isArray(v.passages) ? v.passages.length : 0,
          createdAt: v.createdAt || 0,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jsonResponse({ ok: true, items: items.slice(0, 50) });
}
