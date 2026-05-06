// ─── GET /api/stems/:id/download/:stem ───────────────────────────
// Télécharge une piste isolée d'une séparation (admin-only).
// - Lookup KV pour récupérer title + r2Keys
// - 404 propre si la piste n'existe pas en R2 (cas anciennes séparations 4 stems)
// - Stream du R2 object avec Content-Disposition: attachment + filename slugifié
//
// Le slug du titre est dérivé du title courant en KV (renommable via PATCH).
// Pas de fallback sur originalFilename : si le titre est vide → 'sans-titre'.

import { requireAdminPassword } from '../../../_lib/session.js';

const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function isValidSeparationId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

// Slugify accents-aware (cohérent avec eleves/index.js).
function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.STEMS_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);

  const id = String(params?.id || '');
  const stem = String(params?.stem || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);
  if (!STEM_KEYS.includes(stem)) return jsonResponse({ error: 'bad_stem' }, 400);

  const ts = parseInt(id.split('-')[0], 10);
  if (!Number.isFinite(ts)) return jsonResponse({ error: 'bad_id' }, 400);
  const date = new Date(ts);
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const key = `stems:${ym}:${id}`;

  let entry;
  try {
    entry = await env.MASTERHUB_HISTORY.get(key, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_get_failed', detail: e?.message || '' }, 500);
  }
  if (!entry) return jsonResponse({ error: 'not_found' }, 404);

  const r2Key = entry.r2Keys?.[stem];
  if (!r2Key) return jsonResponse({ error: 'stem_not_found' }, 404);

  let r2Object;
  try {
    r2Object = await env.STEMS_R2.get(r2Key);
  } catch (e) {
    return jsonResponse({ error: 'r2_get_failed', detail: e?.message || '' }, 500);
  }
  if (!r2Object) return jsonResponse({ error: 'r2_object_missing' }, 404);

  const titleSlug = slugify(entry.title) || 'sans-titre';
  const filename = `${titleSlug}-${stem}.mp3`;

  return new Response(r2Object.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
