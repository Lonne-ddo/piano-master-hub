// ─── POST /api/admin/login ───────────────────────────────────────
// Body : { password: string }
// Compare avec env.ADMIN_PASSWORD (fallback '4697' tant que la var n'est
// pas configurée sur CF Pages — voir TODO dans _lib/session.js).
//
// En cas de match : pose le cookie HttpOnly mh_admin_pw signé (HMAC-SHA256),
// TTL 90 jours, Path=/. Réponse { ok: true }.
//
// En cas de mismatch : 401 + délai artificiel ~500ms (anti-bruteforce léger,
// le mot de passe '4697' a un espace de 10000 — délai = ~14h pour bruteforce
// série).

import { checkAdminPassword, buildAdminPasswordSetCookie } from '../_lib/session.js';

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
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const candidate = typeof body?.password === 'string' ? body.password : '';

  if (!checkAdminPassword(candidate, env)) {
    // Délai uniforme ~500ms — masque toute différence de timing entre
    // password vide / wrong / bonne longueur. Le checkAdminPassword est déjà
    // à temps constant, le délai ajoute un ralentisseur de bruteforce.
    await new Promise((r) => setTimeout(r, 500));
    return jsonResponse({ error: 'invalid_password' }, 401);
  }

  const setCookie = await buildAdminPasswordSetCookie(env);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': setCookie });
}
