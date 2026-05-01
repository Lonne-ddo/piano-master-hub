// ─── Helper session côté élève ───────────────────────────────────
// Lit le cookie `mh_session` et résout la session KV correspondante.
// Retourne null si pas de cookie, cookie invalide, ou session expirée/absente.

export async function getSessionFromRequest(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)mh_session=([^;]+)/);
  if (!match) return null;

  const token = match[1];
  let raw;
  try {
    raw = await env.MASTERHUB_STUDENTS.get(`session:${token}`);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    return { token, ...data };
  } catch {
    return null;
  }
}

// Vérifie si un email appartient à la whitelist super-admin (env var
// ADMIN_EMAILS, CSV insensible à la casse). Retourne false si var absente.
export function isAdminEmail(email, env) {
  if (!email || !env || !env.ADMIN_EMAILS) return false;
  const norm = String(email).trim().toLowerCase();
  if (!norm) return false;
  return String(env.ADMIN_EMAILS)
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(norm);
}

// Génère un token random base64url (32 ou 48 bytes selon usage).
export function generateToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
