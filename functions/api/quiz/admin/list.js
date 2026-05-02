// ─── GET /api/quiz/admin/list[?slug=…] ───────────────────────────
// Admin endpoint : liste les sessions de quiz par élève + stats agrégées.
// Auth : super-admin via cookie session (mh_session) + isAdminEmail.
// Stockage source : KV MASTERHUB_QUIZ_HISTORY, clés `quiz:<slug>:<ts>`.
//
// Query :
//   slug=japhet  → ne retourne que cet élève (validé contre whitelist)
//   sans slug    → retourne les 4 élèves
//
// Réponse :
// {
//   ok: true,
//   data: {
//     <slug>: {
//       total: int,
//       avg_score: number (sur 10, 1 décimale),
//       last_session_ts: int|null,
//       last_session_iso: string|null,
//       by_mode: { notes, intervals, chords, scales, progressions },
//       sessions: [{ key, slug, mode, level, score, total, duration_ms, questions[], ts, ts_iso }]  // récentes d'abord
//     }
//   }
// }

import { requireAdmin } from '../../_lib/session.js';

const ELEVES = ['japhet', 'tara', 'dexter', 'messon'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  if (!env.MASTERHUB_QUIZ_HISTORY) {
    return jsonResponse({
      ok: false,
      error: 'kv_not_bound',
      hint: 'Ajouter MASTERHUB_QUIZ_HISTORY dans CF Pages → Settings → Functions → KV namespace bindings',
    }, 500);
  }

  const url = new URL(request.url);
  const slugParam = (url.searchParams.get('slug') || '').toLowerCase();
  const slugs = slugParam
    ? (ELEVES.includes(slugParam) ? [slugParam] : null)
    : ELEVES;

  if (!slugs) {
    return jsonResponse({ ok: false, error: 'invalid_slug' }, 400);
  }

  const result = {};

  for (const s of slugs) {
    let list;
    try {
      list = await env.MASTERHUB_QUIZ_HISTORY.list({ prefix: `quiz:${s}:`, limit: 1000 });
    } catch (e) {
      return jsonResponse({ ok: false, error: 'kv_list_failed', details: e?.message || '' }, 500);
    }

    // Fetch parallèle de chaque session
    const sessions = await Promise.all(
      list.keys.map(async (k) => {
        try {
          const value = await env.MASTERHUB_QUIZ_HISTORY.get(k.name, { type: 'json' });
          if (!value) return null;
          return { key: k.name, ...value };
        } catch {
          return null;
        }
      })
    );

    const valid = sessions.filter(Boolean);

    const total = valid.length;
    const avgScore = total > 0
      ? valid.reduce((sum, sess) => {
          const t = Number(sess.total) || 10;
          const sc = Number(sess.score) || 0;
          return sum + (sc / t) * 10;
        }, 0) / total
      : 0;

    const sortedDesc = valid.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const lastSession = sortedDesc[0] || null;

    const byMode = { notes: 0, intervals: 0, chords: 0, scales: 0, progressions: 0 };
    valid.forEach(sess => {
      if (byMode[sess.mode] !== undefined) byMode[sess.mode]++;
    });

    result[s] = {
      total,
      avg_score: Math.round(avgScore * 10) / 10,
      last_session_ts: lastSession ? lastSession.ts : null,
      last_session_iso: lastSession ? lastSession.ts_iso : null,
      by_mode: byMode,
      sessions: sortedDesc,
    };
  }

  return jsonResponse({ ok: true, data: result });
}
