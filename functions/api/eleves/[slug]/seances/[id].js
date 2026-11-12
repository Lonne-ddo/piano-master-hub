// ─── /api/eleves/:slug/seances/:id ────────────────────────────────
// Admin uniquement (cookie mh_admin_pw).
//   GET    → la séance complète, note_coach comprise (pré-remplissage
//            de « Modifier » ; la liste /seances ne l'expose jamais)
//   PUT    → remplace titre, date, résumé, devoirs, livrable, note_coach
//            (garde id et createdAt, ajoute updatedAt)
//   DELETE → retire la séance de l'historique
// Après PUT/DELETE : numéros, dernière séance et stats recalculés
// (_lib/save-seance.js → commitHistory).

import { requireAdminPassword } from '../../../_lib/session.js';
import { readSeances, updateSeance, deleteSeance, SLUG_RE } from '../../../_lib/save-seance.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(res) {
  const err = { error: res.error };
  if (res.detail !== undefined) err.detail = res.detail;
  return jsonResponse(err, res.status);
}

// Auth admin + validation slug/id. Retourne { slug, id } ou une Response.
async function guard(params, request, env) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  const slug = String(params.slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) return jsonResponse({ error: 'invalid_slug' }, 400);
  const id = String(params.id || '');
  if (!ID_RE.test(id)) return jsonResponse({ error: 'invalid_id' }, 400);
  return { slug, id };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ params, request, env }) {
  const g = await guard(params, request, env);
  if (g instanceof Response) return g;
  let history;
  try { history = await readSeances(env, g.slug); }
  catch (e) { return jsonResponse({ error: 'kv_error', detail: e?.message || '' }, 500); }
  const seance = history.find(s => s && s.id === g.id);
  if (!seance) return jsonResponse({ error: 'Séance introuvable' }, 404);
  return jsonResponse({ ok: true, seance });
}

export async function onRequestPut({ params, request, env }) {
  const g = await guard(params, request, env);
  if (g instanceof Response) return g;
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }
  const res = await updateSeance(env, g.slug, g.id, body);
  if (!res.ok) return errorResponse(res);
  return jsonResponse({ ok: true, entry: res.entry, data: res.data, seances: res.seances });
}

export async function onRequestDelete({ params, request, env }) {
  const g = await guard(params, request, env);
  if (g instanceof Response) return g;
  const res = await deleteSeance(env, g.slug, g.id);
  if (!res.ok) return errorResponse(res);
  return jsonResponse({ ok: true, removed: res.removed, data: res.data, seances: res.seances });
}
