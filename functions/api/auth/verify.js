// ─── GET /api/auth/verify?token=<magic_link_token> ───────────────
// Single-use : consomme le magic_link (delete après lecture), crée une session
// 90 jours en KV, set le cookie httpOnly + secure + samesite=Lax, redirige
// vers /{slug}.
//
// Échecs (token absent / expiré) : redirige vers /?error=missing_token|expired.

import { generateToken } from '../_lib/session.js';

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

  if (!data.slug) {
    return Response.redirect(`${url.origin}/?error=expired`, 302);
  }

  // Création de la session 90j
  const sessionToken = generateToken(48);
  const ua = request.headers.get('user-agent') || 'unknown';
  const sessionData = {
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
      'Location': `${url.origin}/${data.slug}`,
      'Set-Cookie': cookie,
    },
  });
}
