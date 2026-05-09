// ─── Helpers partagés pour /api/analyse/* ────────────────────────
// Constantes, validation ID, slugify, mime types whitelist.

export const MIME_TYPES_ALLOWED = ['video/mp4', 'video/webm', 'video/quicktime'];
export const EXTENSION_BY_MIME = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

// V1 : 100MB (limite CF Pages workers standard, bumper via presigned URL si > en pratique).
export const MAX_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_DURATION_S = 30 * 60; // 30 min

// ID nanoid-like 12 chars, alphabet [A-Za-z0-9_-].
export function genId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += alphabet[buf[i] & 63];
  return out;
}

export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}

// Slugify accents-aware (cohérent avec eleves/index.js + stems download).
export function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
};

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Charge la liste des slugs valides depuis MASTERHUB_STUDENTS.eleves:list.
// Pattern cohérent avec /api/eleves GET (qui seed la clé au bootstrap) et
// les autres handlers (sync.js, [id].js, [slug]/public.js). Fallback sur
// DEFAULT_ELEVES si la clé n'a pas encore été seedée ou si KV down.
const DEFAULT_ELEVES = ['japhet', 'messon', 'dexter', 'tara'];

export async function loadValidSlugs(env) {
  if (!env.MASTERHUB_STUDENTS) return DEFAULT_ELEVES.slice();
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (Array.isArray(list) && list.length) {
      return list.map((s) => String(s).toLowerCase()).filter(Boolean);
    }
    return DEFAULT_ELEVES.slice();
  } catch {
    return DEFAULT_ELEVES.slice();
  }
}
