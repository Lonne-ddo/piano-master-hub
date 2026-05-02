// ─── GET /api/stems/list[?ym=YYYY-MM] ────────────────────────────
// Liste les séparations stockées (success + r2Keys) pour le mois donné
// (par défaut le mois courant). Auth admin.
//
// Réponse :
// {
//   ok: true,
//   ym: "2026-05",
//   items: [{
//     id, title, ts, durationS, sizeMB, costEUR,
//     stems: ["vocals", "drums", ...],   // clés présentes en R2
//     assignedTo: ["messon", ...],
//   }]
// }
//
// Tri : plus récent d'abord. Filtre out les anciennes entries sans r2Keys
// (logs pré-refonte qui n'ont pas d'audio à présenter).

import { requireAdminPassword } from '../_lib/session.js';

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

function ymString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }

  const url = new URL(request.url);
  const ymRaw = url.searchParams.get('ym') || ymString();
  if (!/^\d{4}-\d{2}$/.test(ymRaw)) {
    return jsonResponse({ error: 'bad_ym' }, 400);
  }
  const prefix = `stems:${ymRaw}:`;

  const items = [];
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_HISTORY.list({ prefix, cursor, limit: 1000 });
    } catch (e) {
      return jsonResponse({ error: 'kv_list_failed', detail: e?.message || '' }, 500);
    }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_HISTORY.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (
        v &&
        v.status === 'success' &&
        v.r2Keys &&
        typeof v.r2Keys === 'object' &&
        Object.keys(v.r2Keys).length > 0
      ) {
        items.push({
          id: v.id,
          title: v.title || v.originalFilename || 'Sans titre',
          ts: v.ts,
          durationS: v.durationS || 0,
          sizeMB: v.sizeMB || 0,
          costEUR: v.costEUR || 0,
          stems: Object.keys(v.r2Keys),
          assignedTo: Array.isArray(v.assignedTo) ? v.assignedTo : [],
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  // Tri : plus récent d'abord (ISO string compare descending)
  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  return jsonResponse({ ok: true, ym: ymRaw, items });
}
