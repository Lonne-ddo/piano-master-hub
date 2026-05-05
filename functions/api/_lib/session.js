// ─── Helper session côté élève ───────────────────────────────────
// Lit le cookie `mh_session` et résout la session KV correspondante.
// Retourne null si pas de cookie, cookie invalide, ou session expirée/absente.
//
// Note : depuis la séparation admin/élève, le cookie mh_session ne contient
// QUE des sessions élève (slug). Les anciennes sessions admin (is_admin: true)
// existent encore pendant la fenêtre 90j de leur TTL ; elles sont ignorées
// pour l'auth admin (qui passe par mh_admin_pw / requireAdminPassword).

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

// Génère un token random base64url (32 ou 48 bytes selon usage).
export function generateToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Auth admin par mot de passe (cookie mh_admin_pw HMAC stateless) ────
//
// Le cookie a la forme `<expiresAtMs>.<base64url(HMAC-SHA256(secret, expiresAtMs))>`
// avec `secret = env.ADMIN_PASSWORD` (throw si var non configurée).
//
// Avantages de cette approche :
//   - Stateless : pas de KV write/read sur chaque requête
//   - Pas de var SESSION_SECRET supplémentaire — la clé HMAC dérive du mdp
//     admin lui-même (changer le mdp invalide tous les cookies en cours)
//   - Forge impossible sans connaître le mdp
//   - Expiration auto-vérifiable côté serveur

const ADMIN_COOKIE_NAME = 'mh_admin_pw';
const ADMIN_COOKIE_TTL_S = 90 * 24 * 3600; // 90 jours

function getAdminPassword(env) {
  const pw = env && env.ADMIN_PASSWORD;
  if (!pw) throw new Error('ADMIN_PASSWORD env var not configured');
  return pw;
}

function base64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64urlEncode(new Uint8Array(sig));
}

// Comparaison à temps constant pour éviter les leaks par timing.
function constantTimeStrEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

// Construit la valeur du cookie admin signée pour un TTL en secondes.
export async function buildAdminPasswordCookieValue(env, ttlSeconds = ADMIN_COOKIE_TTL_S) {
  const expiresAt = String(Date.now() + ttlSeconds * 1000);
  const secret = getAdminPassword(env);
  const sig = await hmacSha256(secret, expiresAt);
  return `${expiresAt}.${sig}`;
}

// Construit l'en-tête Set-Cookie complet (Path=/, HttpOnly, Secure, SameSite=Lax).
export async function buildAdminPasswordSetCookie(env, ttlSeconds = ADMIN_COOKIE_TTL_S) {
  const value = await buildAdminPasswordCookieValue(env, ttlSeconds);
  return `${ADMIN_COOKIE_NAME}=${value}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

// En-tête Set-Cookie qui efface le cookie admin (logout).
export function buildAdminPasswordClearCookie() {
  return `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Lit le cookie admin et vérifie expiration + signature HMAC.
// Retourne true si cookie valide non expiré, false sinon.
// Throw si env.ADMIN_PASSWORD n'est pas configuré (CF Pages 500).
export async function requireAdminPassword(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)mh_admin_pw=([^;]+)/);
  if (!match) return false;

  const value = match[1];
  const dotIdx = value.lastIndexOf('.');
  if (dotIdx <= 0) return false;

  const expiresAtStr = value.slice(0, dotIdx);
  const sig = value.slice(dotIdx + 1);

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const secret = getAdminPassword(env);
  let expectedSig;
  try {
    expectedSig = await hmacSha256(secret, expiresAtStr);
  } catch {
    return false;
  }
  return constantTimeStrEq(sig, expectedSig);
}

// Vérifie qu'un mot de passe candidate match env.ADMIN_PASSWORD.
// Comparaison à temps constant. Throw si var non configurée.
export function checkAdminPassword(candidate, env) {
  if (typeof candidate !== 'string') return false;
  return constantTimeStrEq(candidate, getAdminPassword(env));
}

// ─── Helper auth pour endpoints élève ─────────────────────────────
// Vérifie que la requête a le droit d'accéder aux ressources d'un slug donné :
//   - admin (cookie mh_admin_pw signé) → passe-droit (peut consulter tout slug)
//   - élève (session.slug === slug)    → accès à sa propre fiche uniquement
//
// Retourne :
//   { ok: true, role: 'admin'|'eleve', session? }  — accès autorisé
//   { ok: false, status: 401|403, error: string } — accès refusé
export async function requireEleveOrAdmin(slug, request, env) {
  if (await requireAdminPassword(request, env)) {
    return { ok: true, role: 'admin' };
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) return { ok: false, status: 401, error: 'unauthorized' };

  const wanted = String(slug || '').toLowerCase();
  if (session.slug && wanted && session.slug === wanted) {
    return { ok: true, role: 'eleve', session };
  }
  return { ok: false, status: 403, error: 'forbidden' };
}
