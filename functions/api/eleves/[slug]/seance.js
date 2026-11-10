// ─── POST /api/eleves/:slug/seance ───────────────────────────────
// Formulaire post-séance (admin uniquement, cookie mh_admin_pw).
// Body : { n?, date, titre, resume[], devoirs[], livrable?, statut?, note_coach? }
// Validation et enregistrement : _lib/save-seance.js.

import { requireAdminPassword } from '../../_lib/session.js';
import { saveSeance, SLUG_RE } from '../../_lib/save-seance.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const slug = String(params.slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) return jsonResponse({ error: 'invalid_slug' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }

  const res = await saveSeance(env, slug, body);
  if (!res.ok) {
    const err = { error: res.error };
    if (res.detail !== undefined) err.detail = res.detail;
    return jsonResponse(err, res.status);
  }
  return jsonResponse({ ok: true, entry: res.entry, roadmap: res.roadmap, data: res.data, seances: res.seances });
}
