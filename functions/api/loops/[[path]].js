// ─── API Drum Loops ──────────────────────────────────────────────
// Routes (via catch-all) :
//   GET    /api/loops                      → liste loops + categories
//   POST   /api/loops                      → upload (multipart)
//   PATCH  /api/loops/{id}                 → édite métadonnées
//   DELETE /api/loops/{id}                 → supprime loop + audio
//   GET    /api/loops/{id}/audio           → renvoie le binaire MP3
//   POST   /api/loops/categories           → ajoute une catégorie
//   DELETE /api/loops/categories/{name}    → supprime + nettoie tags
//
// Stockage KV : MASTERHUB_LOOPS
//   "loops:index"        → JSON { loops: [...metadata], categories: [...] }
//   "loops:audio:{id}"   → ArrayBuffer (binaire MP3, max 25 MiB par valeur)
//
// Auth : header x-admin-secret obligatoire sur tous les endpoints.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB (sous la limite KV de 25 MiB)
const DEFAULT_CATEGORIES = ['Latin', 'Afro', 'Autre'];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function requireAuth(request, env) {
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function readIndex(env) {
  const raw = await env.MASTERHUB_LOOPS.get('loops:index', { type: 'json' });
  if (!raw) return { loops: [], categories: [...DEFAULT_CATEGORIES] };
  return {
    loops: Array.isArray(raw.loops) ? raw.loops : [],
    categories: Array.isArray(raw.categories) && raw.categories.length
      ? raw.categories
      : [...DEFAULT_CATEGORIES],
  };
}

async function writeIndex(env, index) {
  await env.MASTERHUB_LOOPS.put('loops:index', JSON.stringify(index));
}

// Ajoute toute nouvelle catégorie introduite par les tags (case-insensitive
// pour la comparaison, on conserve la casse fournie)
function ensureCategories(categoriesArr, newTags) {
  for (const tag of newTags) {
    if (!tag) continue;
    const tagLower = String(tag).toLowerCase();
    if (!categoriesArr.some(c => String(c).toLowerCase() === tagLower)) {
      categoriesArr.push(tag);
    }
  }
  return categoriesArr;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Auth obligatoire
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const segments = (params.path && Array.isArray(params.path) ? params.path : []).filter(Boolean);
  const method = request.method;

  try {
    // ── /api/loops ───────────────────────────────────────────
    if (segments.length === 0) {
      if (method === 'GET')  return await handleList(env);
      if (method === 'POST') return await handleUpload(request, env);
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    // ── /api/loops/categories ────────────────────────────────
    if (segments[0] === 'categories') {
      if (segments.length === 1) {
        if (method === 'POST') return await handleAddCategory(request, env);
        return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      }
      if (segments.length === 2) {
        if (method === 'DELETE') return await handleDeleteCategory(env, segments[1]);
        return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      }
      return jsonResponse({ ok: false, error: 'Not found' }, 404);
    }

    // ── /api/loops/{id} ──────────────────────────────────────
    if (segments.length === 1) {
      const id = segments[0];
      if (method === 'PATCH')  return await handlePatch(request, env, id);
      if (method === 'DELETE') return await handleDelete(env, id);
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    // ── /api/loops/{id}/audio ────────────────────────────────
    if (segments.length === 2 && segments[1] === 'audio') {
      const id = segments[0];
      if (method === 'GET') return await handleAudio(env, id);
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[loops]', e?.message || e);
    return jsonResponse({ ok: false, error: e?.message || 'Internal error' }, 500);
  }
}

// ─── Handlers ────────────────────────────────────────────────────

async function handleList(env) {
  const index = await readIndex(env);
  return jsonResponse({ ok: true, loops: index.loops, categories: index.categories });
}

async function handleUpload(request, env) {
  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse({ ok: false, error: 'Multipart invalide' }, 400); }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse({ ok: false, error: 'Champ "file" manquant' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonResponse({
      ok: false,
      error: 'Fichier trop volumineux (max 20 Mo). Compresse-le en MP3 192 kbps ou moins.',
    }, 413);
  }

  const filename = String(formData.get('filename') || file.name || 'loop.mp3');
  const bpmRaw = formData.get('bpm');
  const bpm = (bpmRaw === null || bpmRaw === '' || bpmRaw === 'null')
    ? null
    : Number(bpmRaw);
  const tagsRaw = formData.get('tags');
  let tags = [];
  if (tagsRaw) {
    try { tags = JSON.parse(tagsRaw); }
    catch { tags = []; }
  }
  if (!Array.isArray(tags)) tags = [];
  tags = tags.map(String).filter(Boolean);

  const trimMs = Number(formData.get('trim_ms') || 0);
  const durationSec = Number(formData.get('duration_sec') || 0);

  const id = uuid();
  const buffer = await file.arrayBuffer();

  // Stocke le binaire MP3 directement dans KV (ArrayBuffer, pas de base64 → pas
  // d'overhead de 33 % → ~20 MiB raw OK sous la limite 25 MiB)
  await env.MASTERHUB_LOOPS.put(`loops:audio:${id}`, buffer);

  const meta = {
    id,
    filename,
    size_bytes: buffer.byteLength,
    duration_sec: Number.isFinite(durationSec) ? durationSec : 0,
    bpm: Number.isFinite(bpm) ? bpm : null,
    tags,
    trim_ms: Number.isFinite(trimMs) ? trimMs : 0,
    uploaded_at: new Date().toISOString(),
  };

  const index = await readIndex(env);
  index.loops.push(meta);
  ensureCategories(index.categories, tags);
  await writeIndex(env, index);

  return jsonResponse({ ok: true, loop: meta, categories: index.categories });
}

async function handlePatch(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'JSON invalide' }, 400); }

  const index = await readIndex(env);
  const i = index.loops.findIndex(l => l.id === id);
  if (i < 0) return jsonResponse({ ok: false, error: 'Loop introuvable' }, 404);

  const loop = { ...index.loops[i] };
  if (typeof body.filename === 'string' && body.filename.trim()) {
    loop.filename = body.filename.trim();
  }
  if (body.bpm !== undefined) {
    if (body.bpm === null || body.bpm === '') {
      loop.bpm = null;
    } else {
      const n = Number(body.bpm);
      loop.bpm = Number.isFinite(n) ? n : null;
    }
  }
  if (Array.isArray(body.tags)) {
    loop.tags = body.tags.map(String).filter(Boolean);
    ensureCategories(index.categories, loop.tags);
  }
  if (body.trim_ms !== undefined) {
    const n = Number(body.trim_ms);
    loop.trim_ms = Number.isFinite(n) ? n : 0;
  }
  loop.updated_at = new Date().toISOString();

  index.loops[i] = loop;
  await writeIndex(env, index);
  return jsonResponse({ ok: true, loop, categories: index.categories });
}

async function handleDelete(env, id) {
  const index = await readIndex(env);
  const i = index.loops.findIndex(l => l.id === id);
  if (i < 0) return jsonResponse({ ok: false, error: 'Loop introuvable' }, 404);

  await env.MASTERHUB_LOOPS.delete(`loops:audio:${id}`);
  index.loops.splice(i, 1);
  await writeIndex(env, index);
  return jsonResponse({ ok: true });
}

async function handleAudio(env, id) {
  const buf = await env.MASTERHUB_LOOPS.get(`loops:audio:${id}`, { type: 'arrayBuffer' });
  if (!buf) return jsonResponse({ ok: false, error: 'Audio introuvable' }, 404);
  return new Response(buf, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      // private = browser cache OK, pas de cache CDN partagé (auth-protected)
      'Cache-Control': 'private, max-age=86400',
      'Content-Length': String(buf.byteLength),
    },
  });
}

async function handleAddCategory(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'JSON invalide' }, 400); }

  const name = String(body.name || '').trim();
  if (!name) return jsonResponse({ ok: false, error: 'Nom de catégorie requis' }, 400);
  if (name.length > 30) return jsonResponse({ ok: false, error: 'Nom trop long (max 30 caractères)' }, 400);

  const index = await readIndex(env);
  const exists = index.categories.some(c => String(c).toLowerCase() === name.toLowerCase());
  if (!exists) index.categories.push(name);
  await writeIndex(env, index);
  return jsonResponse({ ok: true, categories: index.categories });
}

async function handleDeleteCategory(env, encodedName) {
  let name;
  try { name = decodeURIComponent(encodedName); }
  catch { name = encodedName; }
  const lower = String(name).toLowerCase();

  const index = await readIndex(env);
  index.categories = index.categories.filter(c => String(c).toLowerCase() !== lower);
  let affected = 0;
  for (const loop of index.loops) {
    if (Array.isArray(loop.tags)) {
      const newTags = loop.tags.filter(t => String(t).toLowerCase() !== lower);
      if (newTags.length !== loop.tags.length) {
        loop.tags = newTags;
        affected++;
      }
    }
  }
  await writeIndex(env, index);
  return jsonResponse({ ok: true, categories: index.categories, affected });
}
