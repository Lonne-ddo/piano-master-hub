// ─── GET /api/eleves/:slug/seances ───────────────────────────────
// Historique des séances publiées (formulaire post-séance ou connecteur
// MCP), de la plus récente à la plus ancienne.
// Auth : élève sur sa propre fiche (mh_session) ou admin (mh_admin_pw).
// Whitelist des champs : JAMAIS de note_coach (privée coach).

import { requireEleveOrAdmin } from '../../_lib/session.js';
import { readSeances, SLUG_RE } from '../../_lib/save-seance.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const strList = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s) : []);

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params.slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) return jsonResponse({ error: 'invalid_slug' }, 400);

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let history;
  try {
    history = await readSeances(env, slug);
  } catch (e) {
    return jsonResponse({ error: 'kv_error', detail: e?.message || '' }, 500);
  }

  // Historique stocké en ordre chronologique croissant (tri stable) :
  // l'inverse donne la plus récente d'abord.
  const seances = history.slice().reverse().map(s => ({
    id: s.id || null,
    n: Number.isInteger(s.n) ? s.n : null,
    date: typeof s.date === 'string' ? s.date : '',
    titre: typeof s.titre === 'string' ? s.titre : '',
    resume: strList(s.resume),
    devoirs: strList(s.devoirs),
    livrable: typeof s.livrable === 'string' ? s.livrable : '',
  }));

  return jsonResponse({ slug, seances });
}
