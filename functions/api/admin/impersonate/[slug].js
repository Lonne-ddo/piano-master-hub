// ─── POST /api/admin/impersonate/:slug ───────────────────────────
// Crée une session élève éphémère (TTL 7j) avec flag isAdminImpersonation
// pour permettre à l'admin de voir l'espace d'un élève sans magic link.
//
// Auth : super-admin via cookie mh_admin_pw (HMAC). Refusé sinon.
// Validation : slug doit correspondre à une entrée KV `eleve:<slug>` existante.
//
// Effet : Set-Cookie mh_session=<token> en parallèle du cookie admin
// existant (cookies indépendants, non-destructif). L'admin pourra revenir
// à son contexte admin via POST /api/auth/logout (clear mh_session) qui
// préserve le cookie mh_admin_pw.
//
// TTL court (7j vs 90j d'un login normal) : limite la durée d'impersonation
// si l'admin oublie de quitter.

import { requireAdminPassword, generateToken } from '../../_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const IMPERSONATION_TTL_S = 7 * 24 * 3600; // 7 jours

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_STUDENTS) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }

  const slug = String(params?.slug || '').toLowerCase().trim();
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    return jsonResponse({ error: 'invalid_slug' }, 400);
  }

  // Vérifier que l'élève existe
  let eleve;
  try {
    eleve = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_get_failed', detail: e?.message || '' }, 500);
  }
  if (!eleve) {
    return jsonResponse({ error: 'eleve_not_found', slug }, 404);
  }

  // Génère token + crée la session KV avec flag d'impersonation
  const sessionToken = generateToken(48);
  const ua = request.headers.get('user-agent') || 'unknown';
  const sessionData = {
    slug,
    email: typeof eleve.email === 'string' ? eleve.email : null,
    name: typeof eleve.nom === 'string' ? eleve.nom : null,
    isAdminImpersonation: true,
    impersonatedAt: Date.now(),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ua: String(ua).slice(0, 200),
  };
  try {
    await env.MASTERHUB_STUDENTS.put(
      `session:${sessionToken}`,
      JSON.stringify(sessionData),
      { expirationTtl: IMPERSONATION_TTL_S },
    );
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  const cookie = `mh_session=${sessionToken}; Path=/; Max-Age=${IMPERSONATION_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
  return jsonResponse(
    { ok: true, slug, name: sessionData.name },
    200,
    { 'Set-Cookie': cookie },
  );
}
