// ─── Limitation de débit (fenêtre fixe, KV MASTERHUB_STUDENTS) ────
// Clés `rl:<scope>:<id>:<fenêtre>` avec TTL court. KV est à cohérence
// éventuelle et met les lectures en cache (~60 s) : seul, un compteur KV
// laisserait passer une rafale. On le double d'un compteur en mémoire de
// l'isolate (les rafales d'une même IP tombent en général sur le même) ;
// le compteur retenu est le max des deux. Limite approximative, suffisante
// contre le bruteforce lent et le spam d'emails.

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

const memCounts = new Map();  // clé KV → compteur, par isolate

function memGet(key) {
  return memCounts.get(key) || 0;
}

function memSet(key, n) {
  if (memCounts.size > 5000) memCounts.clear();  // borne mémoire ; les fenêtres expirées partent avec
  memCounts.set(key, n);
}

function windowKey(scope, id, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  return { key: `rl:${scope}:${id}:${win}`, retryAfter: (win + 1) * windowSec - Math.floor(Date.now() / 1000) };
}

async function readCount(env, key) {
  try {
    return parseInt(await env.MASTERHUB_STUDENTS.get(key), 10) || 0;
  } catch {
    return 0;
  }
}

// Limite atteinte ? → { limited: boolean, retryAfter: secondes }
export async function isRateLimited(env, scope, id, limit, windowSec) {
  if (!env.MASTERHUB_STUDENTS) return { limited: false, retryAfter: 0 };
  const { key, retryAfter } = windowKey(scope, id, windowSec);
  const n = Math.max(await readCount(env, key), memGet(key));
  return { limited: n >= limit, retryAfter };
}

// Compte une tentative dans la fenêtre courante.
export async function recordAttempt(env, scope, id, windowSec) {
  if (!env.MASTERHUB_STUDENTS) return;
  const { key } = windowKey(scope, id, windowSec);
  const n = Math.max(await readCount(env, key), memGet(key)) + 1;
  memSet(key, n);
  try {
    // TTL KV minimum = 60 s
    await env.MASTERHUB_STUDENTS.put(key, String(n), { expirationTtl: Math.max(60, windowSec + 60) });
  } catch { /* la limitation ne doit jamais casser le flux */ }
}

// Vérifie puis compte (cas où chaque requête compte, réussie ou non).
export async function consumeRateLimit(env, scope, id, limit, windowSec) {
  const r = await isRateLimited(env, scope, id, limit, windowSec);
  if (!r.limited) await recordAttempt(env, scope, id, windowSec);
  return r;
}
