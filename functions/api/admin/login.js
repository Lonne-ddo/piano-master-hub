// ─── POST /api/admin/login ───────────────────────────────────────
// Body : { password: string }
// Compare avec env.ADMIN_PASSWORD (fallback '4697' tant que la var n'est
// pas configurée sur CF Pages — voir TODO dans _lib/session.js).
//
// En cas de match : pose le cookie HttpOnly mh_admin_pw signé (HMAC-SHA256),
// TTL 90 jours, Path=/. Réponse { ok: true }.
//
// En cas de mismatch : 401 + délai artificiel ~500ms.
// Limitation : 5 échecs / 15 min / IP, puis 429 jusqu'à la fin de la fenêtre.

import { checkAdminPassword, buildAdminPasswordSetCookie } from '../_lib/session.js';
import { clientIp, isRateLimited, recordAttempt } from '../_lib/rate-limit.js';

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_S = 15 * 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const ip = clientIp(request);
  const rl = await isRateLimited(env, 'admin-login', ip, LOGIN_MAX_FAILURES, LOGIN_WINDOW_S);
  if (rl.limited) {
    return jsonResponse({ error: 'too_many_attempts' }, 429, { 'Retry-After': String(rl.retryAfter) });
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const candidate = typeof body?.password === 'string' ? body.password : '';

  if (!checkAdminPassword(candidate, env)) {
    // Délai uniforme ~500ms — masque toute différence de timing entre
    // password vide / wrong / bonne longueur. Le checkAdminPassword est déjà
    // à temps constant, le délai ajoute un ralentisseur de bruteforce.
    await recordAttempt(env, 'admin-login', ip, LOGIN_WINDOW_S);
    await new Promise((r) => setTimeout(r, 500));
    return jsonResponse({ error: 'invalid_password' }, 401);
  }

  const setCookie = await buildAdminPasswordSetCookie(env);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': setCookie });
}
