// ─── POST /api/quiz/admin/migrate-chord-ids ─────────────────────────
// Endpoint admin one-shot pour migrer les ids d'accords legacy (m7, m, m7b5,
// m6, m9, m11) vers la convention canonique MhTheory (min7, min, etc.) dans
// les sessions historiques de MASTERHUB_QUIZ_HISTORY.
//
// Auth : super-admin via cookie session (mh_session) + isAdminEmail.
//
// À lancer manuellement après le commit qui aligne quiz-engine sur MhTheory,
// depuis la console DevTools sur /admin/ (cookie envoyé automatiquement) :
//   fetch('/api/quiz/admin/migrate-chord-ids', { method: 'POST', credentials: 'same-origin' })
//     .then(r => r.json()).then(console.log)
//
// Idempotent : peut être relancé sans risque (les ids déjà migrés ne sont pas
// re-touchés). Marque chaque entrée mise à jour avec _migrated.

import { requireAdmin } from '../../_lib/session.js';

const MIGRATION_MAP = {
  'm':      'min',
  'm6':     'min6',
  'm7':     'min7',
  'm7b5':   'min7b5',
  'm9':     'min9',
  'm11':    'min11'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_QUIZ_HISTORY) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  let list;
  try {
    list = await env.MASTERHUB_QUIZ_HISTORY.list({ prefix: 'quiz:', limit: 1000 });
  } catch (e) {
    return json({ ok: false, error: 'kv_list_failed', details: e?.message || '' }, 500);
  }

  let scanned = 0;
  let updated = 0;
  const errors = [];

  for (const k of list.keys) {
    scanned++;
    try {
      const raw = await env.MASTERHUB_QUIZ_HISTORY.get(k.name);
      if (!raw) continue;
      const data = JSON.parse(raw);
      let dirty = false;

      // Migrer chord ids dans questions[]
      if (Array.isArray(data.questions)) {
        for (const q of data.questions) {
          if (typeof q.asked === 'string' && MIGRATION_MAP[q.asked]) {
            q.asked = MIGRATION_MAP[q.asked];
            dirty = true;
          }
          if (typeof q.given === 'string' && MIGRATION_MAP[q.given]) {
            q.given = MIGRATION_MAP[q.given];
            dirty = true;
          }
        }
      }

      if (dirty) {
        data._migrated = { ts: Date.now(), v: 'chord-ids-min-prefix' };
        try {
          await env.MASTERHUB_QUIZ_HISTORY.put(k.name, JSON.stringify(data));
          updated++;
        } catch (e) {
          errors.push({ key: k.name, error: 'put_failed: ' + (e?.message || '') });
        }
      }
    } catch (e) {
      errors.push({ key: k.name, error: e?.message || String(e) });
    }
  }

  return json({
    ok: true,
    scanned,
    updated,
    errors,
    list_complete: !list.list_complete === false ? !list.list_complete : true,
    note: 'Idempotent. Si list_complete=false, des sessions au-delà de 1000 existent — relancer.'
  });
}
