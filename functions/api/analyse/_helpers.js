// ─── Helpers partagés pour /api/analyse/* ────────────────────────
// Constantes, validation ID, slugify, mime types audio whitelist, pipeline
// Replicate htdemucs_6s (réutilise la config de l'ancien /api/stems).

// ─── MIME whitelist : audio + vidéo (extrait audio only) ─────────
// Audio direct OU vidéo (TikTok/IG) dont seul l'audio sera utilisé.
// Le browser élève joue via <audio src="..."> qui ignore le track vidéo.
// Replicate htdemucs_6s accepte aussi les fichiers vidéo en entrée
// (extrait l'audio automatiquement).
export const MIME_TYPES_ALLOWED = [
  // Audio
  'audio/mpeg',         // mp3
  'audio/mp3',          // alias non-standard mais émis par certains clients
  'audio/wav',          // wav
  'audio/x-wav',        // wav (Safari)
  'audio/x-m4a',        // m4a (iOS/macOS)
  'audio/mp4',          // m4a (AAC)
  'audio/aac',          // aac brut
  'audio/flac',         // flac
  'audio/x-flac',       // flac (alternative)
  // Vidéo (audio extrait à la lecture / par Demucs)
  'video/mp4',          // mp4 (TikTok, IG Reels, exports mobile)
  'video/quicktime',    // mov (iPhone)
  'video/webm',         // webm (Web exports)
];

export const EXTENSION_BY_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

// V1 : 100MB (limite CF Pages workers standard, bumper via presigned URL si > en pratique).
export const MAX_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_DURATION_S = 30 * 60; // 30 min

// ─── Pipeline Replicate (mode multitrack) ────────────────────────
// Réplique de la config /api/stems.js — séparation Demucs htdemucs_6s.
export const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];
export const REPLICATE_VERSION = '5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77';
export const DEMUCS_MODEL = 'htdemucs_6s';
export const MONTHLY_CAP = 20;
export const COST_EUR_PER_RUN = 0.02;

// Normalise l'output Replicate (object ou array legacy) en {stem: url, ...}.
export function normalizeReplicateOutput(output) {
  if (!output) return {};
  if (Array.isArray(output)) {
    // Ordre legacy htdemucs_6s
    const order = ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar'];
    const out = {};
    output.forEach((url, i) => {
      if (order[i] && url) out[order[i]] = url;
    });
    return out;
  }
  if (typeof output === 'object') {
    const out = {};
    for (const k of STEM_KEYS) {
      if (typeof output[k] === 'string') out[k] = output[k];
    }
    return out;
  }
  return {};
}

// ─── ID generation + validation ──────────────────────────────────
// Nouveau format : nanoid 12 chars, alphabet [A-Za-z0-9_-].
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

// Legacy stems ID format `<ts>-<predIdShort>` (cf /api/stems). Permet de
// router automatiquement les anciennes séparations vers /api/stems/...
// quand on les rencontre dans le merge legacy de /api/eleves/:slug/analyse.
export function isLegacyStemsId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

// ─── Slugify accents-aware ───────────────────────────────────────
// Cohérent avec eleves/index.js + stems download.
export function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── CORS + Response helper ──────────────────────────────────────
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

// ─── Cap mensuel Replicate (multitrack only) ─────────────────────
// Compte les success type='multitrack' du mois courant en KV (prefix scan).
// Single n'est pas comptabilisé (gratuit). Vérifié AVANT call Replicate.
export async function countMonthlyMultitrack(env) {
  if (!env.MASTERHUB_ANALYSE) return 0;
  const now = new Date();
  const ymPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let count = 0;
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_ANALYSE.list({ prefix: 'analyse:', cursor, limit: 1000 });
    } catch { return count; }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_ANALYSE.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (
        v && v.type === 'multitrack' && v.status === 'success' &&
        typeof v.uploadedAt === 'number'
      ) {
        const d = new Date(v.uploadedAt);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (ym === ymPrefix) count++;
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return count;
}

// ─── Liste élèves valides ────────────────────────────────────────
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
