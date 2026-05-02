// ─── GET /api/eleves/:slug/stems ─────────────────────────────────
// Liste les séparations Demucs assignées à un élève donné.
// Auth : élève (cookie mh_session avec slug = :slug) OU admin (mh_admin_pw).
//
// Réponse :
// { ok: true, items: [{
//     id, title, ts, durationS, stems: [...]
// }] }
//
// Implementation : scan KV sur les 12 derniers mois civils (suffisant pour
// l'historique pédagogique courant). Pour chaque entrée success, vérifie
// que assignedTo inclut le slug, et expose juste les métadonnées + clés
// stems disponibles. L'audio est servi par /api/stems/:id/audio/:stem.

import { requireEleveOrAdmin } from '../../_lib/session.js';

const VALID_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];
const SCAN_MONTHS = 12;

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

function ymFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!VALID_SLUGS.includes(slug)) {
    return jsonResponse({ error: 'invalid_slug' }, 400);
  }

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env.MASTERHUB_HISTORY) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }

  // Scan les 12 derniers mois civils (incluant le courant)
  const now = new Date();
  const items = [];
  for (let i = 0; i < SCAN_MONTHS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prefix = `stems:${ymFromDate(d)}:`;

    let cursor;
    while (true) {
      let page;
      try {
        page = await env.MASTERHUB_HISTORY.list({ prefix, cursor, limit: 1000 });
      } catch { break; }
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
          Array.isArray(v.assignedTo) &&
          v.assignedTo.includes(slug)
        ) {
          items.push({
            id: v.id,
            title: v.title || 'Sans titre',
            ts: v.ts,
            durationS: v.durationS || 0,
            stems: Object.keys(v.r2Keys),
          });
        }
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  }

  // Tri : plus récent d'abord
  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return jsonResponse({ ok: true, items });
}
