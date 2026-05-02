// ─── GET /api/stems/stats ───────────────────────────────────────
// Stats du mois courant pour le compteur "Ce mois : N · ~Y €" sur le hub admin.
// Auth : admin via cookie mh_admin_pw (HMAC).
//
// Réponse : { ok: true, ym: "YYYY-MM", count: int, costEUR: number }
// (count = nombre de runs status === 'success' uniquement)

import { requireAdminPassword } from '../_lib/session.js';

const COST_EUR_PER_RUN = 0.02;
const MONTHLY_CAP = 20;

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

  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `stems:${ym}:`;

  let count = 0;
  let cursor;
  // Pagination KV.list (1000 keys max par page) — au pire ~50 pages/mois si volume énorme
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_HISTORY.list({ prefix, cursor, limit: 1000 });
    } catch (e) {
      return jsonResponse({ error: 'kv_list_failed', detail: e?.message || '' }, 500);
    }
    // Fetch parallèle des valeurs pour filtrer status === 'success'
    const values = await Promise.all(page.keys.map(async (k) => {
      try {
        return await env.MASTERHUB_HISTORY.get(k.name, { type: 'json' });
      } catch { return null; }
    }));
    for (const v of values) {
      if (v && v.status === 'success') count++;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return jsonResponse({
    ok: true,
    ym,
    count,
    cap: MONTHLY_CAP,
    costEUR: Math.round(count * COST_EUR_PER_RUN * 100) / 100,
  });
}
