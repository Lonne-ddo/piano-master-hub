// ─── Limitation de débit (fenêtre fixe, KV MASTERHUB_STUDENTS) ────
// Clés `rl:<scope>:<id>:<fenêtre>` avec TTL court. KV est à cohérence
// éventuelle : la limite est approximative (quelques essais de marge en
// rafale), suffisant contre le bruteforce et le spam d'emails.

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
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
  return { limited: (await readCount(env, key)) >= limit, retryAfter };
}

// Compte une tentative dans la fenêtre courante.
export async function recordAttempt(env, scope, id, windowSec) {
  if (!env.MASTERHUB_STUDENTS) return;
  const { key } = windowKey(scope, id, windowSec);
  const n = await readCount(env, key);
  try {
    // TTL KV minimum = 60 s
    await env.MASTERHUB_STUDENTS.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec + 60) });
  } catch { /* la limitation ne doit jamais casser le flux */ }
}

// Vérifie puis compte (cas où chaque requête compte, réussie ou non).
export async function consumeRateLimit(env, scope, id, limit, windowSec) {
  const r = await isRateLimited(env, scope, id, limit, windowSec);
  if (!r.limited) await recordAttempt(env, scope, id, windowSec);
  return r;
}
