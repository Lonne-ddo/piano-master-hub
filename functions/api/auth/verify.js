// ─── GET /api/auth/verify?token=<magic_link_token> ───────────────
// Single-use : consomme le magic_link (delete après lecture), crée une session
// 90 jours en KV, set le cookie httpOnly + secure + samesite=Lax, redirige
// vers /{slug}.
//
// Échecs (token absent / expiré) : redirige vers /?error=missing_token|expired.

import { generateToken, isAdminEmail } from '../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return Response.redirect(`${url.origin}/?error=missing_token`, 302);
  }

  let raw;
  try {
    raw = await env.MASTERHUB_STUDENTS.get(`magic_link:${token}`);
  } catch (e) {
    console.error('[auth/verify] KV get failed:', e?.message || e);
    return Response.redirect(`${url.origin}/?error=kv_error`, 302);
  }
  if (!raw) {
    return Response.redirect(`${url.origin}/?error=expired`, 302);
  }

  let data;
  try { data = JSON.parse(raw); }
  catch { return Response.redirect(`${url.origin}/?error=expired`, 302); }

  // Single-use : delete immédiatement (même si la suite échoue, le token est brûlé)
  try { await env.MASTERHUB_STUDENTS.delete(`magic_link:${token}`); }
  catch (e) { console.error('[auth/verify] KV delete (non-fatal):', e?.message || e); }

  // Le magic link doit être soit admin, soit lié à un slug
  if (!data.is_admin && !data.slug) {
    return Response.redirect(`${url.origin}/?error=expired`, 302);
  }

  // Defense-in-depth : si le magic_link était admin mais l'email a été retiré
  // de ADMIN_EMAILS dans la fenêtre 15 min, ne pas créer de session admin.
  if (data.is_admin && !isAdminEmail(data.email, env)) {
    console.warn('[auth/verify] admin email removed from ADMIN_EMAILS during 15-min window:', data.email);
    return Response.redirect(`${url.origin}/?error=expired`, 302);
  }

  // Création de la session 90j (admin = pas de slug)
  const sessionToken = generateToken(48);
  const ua = request.headers.get('user-agent') || 'unknown';
  const sessionData = data.is_admin
    ? {
        is_admin: true,
        email: data.email || null,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ua: String(ua).slice(0, 200),
      }
    : {
        slug: data.slug,
        email: data.email || null,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ua: String(ua).slice(0, 200),
      };
  const ninetyDaysSec = 90 * 24 * 60 * 60;
  try {
    await env.MASTERHUB_STUDENTS.put(
      `session:${sessionToken}`,
      JSON.stringify(sessionData),
      { expirationTtl: ninetyDaysSec }
    );
  } catch (e) {
    console.error('[auth/verify] KV session put failed:', e?.message || e);
    return Response.redirect(`${url.origin}/?error=kv_error`, 302);
  }

  const cookie = `mh_session=${sessionToken}; Path=/; Max-Age=${ninetyDaysSec}; HttpOnly; Secure; SameSite=Lax`;

  return new Response(null, {
    status: 302,
    headers: {
      // Admin → atterrit sur / (chooser) ; élève → /?eleve=slug (query string
      // car CF Pages rewrite /{slug} de façon non fiable, cf commit fix routing).
      'Location': data.is_admin
        ? `${url.origin}/`
        : `${url.origin}/?eleve=${encodeURIComponent(data.slug)}`,
      'Set-Cookie': cookie,
    },
  });
}
