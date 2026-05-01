// ─── POST /api/auth/logout ───────────────────────────────────────
// Supprime la session KV correspondante au cookie `mh_session` puis efface
// le cookie côté client (Max-Age=0).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)mh_session=([^;]+)/);

  if (match && env.MASTERHUB_STUDENTS) {
    try { await env.MASTERHUB_STUDENTS.delete(`session:${match[1]}`); }
    catch (e) { console.error('[auth/logout] KV delete (non-fatal):', e?.message || e); }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Set-Cookie': 'mh_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    },
  });
}
