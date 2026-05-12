// ─── /api/eleves/:slug/devoirs ───────────────────────────────────
// GET  : retourne les bullets devoirs auto-syncés depuis le doc_id de
//        l'élève (cache 1h, stale-while-error). Si cache absent/stale,
//        trigger refresh inline.
// POST : refresh forcé (ignore cache). Si fetch fail mais cache existant,
//        retourne 502 + ancien cache.
//
// Auth : admin OU élève sur sa propre fiche (requireEleveOrAdmin).
//
// KV : MASTERHUB_STUDENTS, clé `devoirs:<slug>` :
//   { bullets: string[], lastFetchedAt: number, sourceDocId: string,
//     fetchStatus: 'ok' | 'error' | 'no_doc_id' }

import { requireEleveOrAdmin } from '../../_lib/session.js';
import { fetchAndParseDevoirs } from '../../_lib/devoirs-parser.js';

const FALLBACK_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function isValidSlug(slug, env) {
  if (!env.MASTERHUB_STUDENTS) return FALLBACK_SLUGS.includes(slug);
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const valid = Array.isArray(list) && list.length ? list : FALLBACK_SLUGS;
    return valid.includes(slug);
  } catch {
    return FALLBACK_SLUGS.includes(slug);
  }
}

// Lit le doc_id de l'élève depuis MASTERHUB_STUDENTS:eleve:<slug>.
async function getDocId(env, slug) {
  try {
    const eleve = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
    return eleve?.doc_id || null;
  } catch {
    return null;
  }
}

async function readCache(env, slug) {
  try {
    return await env.MASTERHUB_STUDENTS.get(`devoirs:${slug}`, { type: 'json' });
  } catch {
    return null;
  }
}

async function writeCache(env, slug, payload) {
  try {
    await env.MASTERHUB_STUDENTS.put(`devoirs:${slug}`, JSON.stringify(payload));
  } catch (e) {
    console.warn('[devoirs] KV put failed', slug, e?.message || e);
  }
}

// Refresh : fetch + parse + write KV. Si fetch fail et cache exists, garde
// l'ancien cache (stale-while-error). Retourne le payload final servi.
async function doRefresh(env, slug, existing) {
  const docId = await getDocId(env, slug);
  if (!docId) {
    const payload = {
      bullets: [],
      lastFetchedAt: Date.now(),
      sourceDocId: null,
      fetchStatus: 'no_doc_id',
    };
    await writeCache(env, slug, payload);
    return { payload, hadError: false };
  }
  const result = await fetchAndParseDevoirs(docId);
  if (result.status === 'ok') {
    const payload = {
      bullets: result.bullets,
      lastFetchedAt: Date.now(),
      sourceDocId: result.docId,
      fetchStatus: 'ok',
    };
    await writeCache(env, slug, payload);
    return { payload, hadError: false };
  }
  // Fetch fail : si on a déjà un cache, le préserve. Sinon écrit un payload error vide.
  if (existing && existing.bullets) {
    // Stale-while-error : on garde l'ancien cache, on update juste lastFetchedAt
    // pour pas re-tenter à chaque GET (back-off implicite via CACHE_TTL_MS).
    const payload = {
      ...existing,
      lastFetchedAt: Date.now(),
      fetchStatus: 'error',
      lastError: result.error || 'fetch_failed',
    };
    await writeCache(env, slug, payload);
    return { payload, hadError: true };
  }
  const payload = {
    bullets: [],
    lastFetchedAt: Date.now(),
    sourceDocId: result.docId,
    fetchStatus: 'error',
    lastError: result.error || 'fetch_failed',
  };
  await writeCache(env, slug, payload);
  return { payload, hadError: true };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// GET : retourne le cache ; refresh inline si > 1h ou absent.
export async function onRequestGet({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!await isValidSlug(slug, env)) return jsonResponse({ error: 'invalid_slug' }, 400);

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env.MASTERHUB_STUDENTS) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const existing = await readCache(env, slug);
  const fresh = existing
    && typeof existing.lastFetchedAt === 'number'
    && (Date.now() - existing.lastFetchedAt) < CACHE_TTL_MS;

  if (existing && fresh) {
    return jsonResponse({
      bullets: Array.isArray(existing.bullets) ? existing.bullets : [],
      lastFetchedAt: existing.lastFetchedAt,
      stale: false,
      status: existing.fetchStatus || 'ok',
    });
  }

  // Cache absent ou stale → refresh inline
  const { payload, hadError } = await doRefresh(env, slug, existing);
  return jsonResponse({
    bullets: Array.isArray(payload.bullets) ? payload.bullets : [],
    lastFetchedAt: payload.lastFetchedAt,
    stale: hadError && existing ? true : false,
    status: payload.fetchStatus,
  });
}

// POST : refresh forcé (ignore cache TTL).
export async function onRequestPost({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!await isValidSlug(slug, env)) return jsonResponse({ error: 'invalid_slug' }, 400);

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env.MASTERHUB_STUDENTS) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const docId = await getDocId(env, slug);
  if (!docId) return jsonResponse({ error: 'no_drive_url' }, 404);

  const existing = await readCache(env, slug);
  const { payload, hadError } = await doRefresh(env, slug, existing);

  if (hadError) {
    return jsonResponse({
      bullets: Array.isArray(payload.bullets) ? payload.bullets : [],
      lastFetchedAt: payload.lastFetchedAt,
      status: 'error',
      stale: !!existing,
      error: payload.lastError || 'fetch_failed',
    }, 502);
  }
  return jsonResponse({
    bullets: payload.bullets,
    lastFetchedAt: payload.lastFetchedAt,
    status: 'ok',
    stale: false,
  });
}
