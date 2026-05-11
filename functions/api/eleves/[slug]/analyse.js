// ─── GET /api/eleves/:slug/analyse ───────────────────────────────
// Liste les contenus Analyse assignés à un élève. Merge 2 sources :
//   1. Nouveaux records MASTERHUB_ANALYSE (single + multitrack, type explicite)
//   2. Anciens records MASTERHUB_HISTORY 'stems:*' (legacy Demucs) →
//      format unifié avec drapeau legacy: true pour router le player vers
//      les anciens endpoints /api/stems/:id/audio/:stem.
//
// Auth : admin OU élève sur sa propre fiche (requireEleveOrAdmin).
//
// Réponse : { ok, items: [...] } trié uploadedAt desc, unifié au schéma :
//   {
//     id, title, type: 'single' | 'multitrack',
//     durationSeconds, sizeBytes (best-effort), mimeType,
//     uploadedAt, status,
//     stems: ['vocals', ...]      // [] si single
//     streamUrl                   // /api/analyse/:id/stream OU /api/stems/:id/audio/vocals (1er stem si legacy)
//     trackUrlPrefix              // '/api/analyse/:id/stream/' ou '/api/stems/:id/audio/' selon legacy
//     legacy: bool                // true = vient de MASTERHUB_HISTORY stems
//   }

import { requireEleveOrAdmin } from '../../_lib/session.js';

const FALLBACK_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// Liste les records MASTERHUB_ANALYSE assignés au slug.
async function listNewAnalyses(env, slug) {
  if (!env.MASTERHUB_ANALYSE) return [];
  const out = [];
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_ANALYSE.list({ prefix: 'analyse:', cursor, limit: 1000 });
    } catch { return out; }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_ANALYSE.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (
        v && v.id && v.status === 'success' &&
        Array.isArray(v.assignedTo) && v.assignedTo.includes(slug)
      ) {
        const type = v.type || 'single';
        const stems = (v.r2KeysStems && typeof v.r2KeysStems === 'object')
          ? Object.keys(v.r2KeysStems) : [];
        out.push({
          id: v.id,
          title: v.title || 'Sans titre',
          type,
          durationSeconds: v.durationSeconds || 0,
          sizeBytes: v.sizeBytes || 0,
          mimeType: v.mimeType || 'audio/mpeg',
          uploadedAt: v.uploadedAt || 0,
          status: 'success',
          stems,
          streamUrl: `/api/analyse/${encodeURIComponent(v.id)}/stream`,
          trackUrlPrefix: `/api/analyse/${encodeURIComponent(v.id)}/stream/`,
          legacy: false,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

// Liste les anciens records MASTERHUB_HISTORY stems:* assignés au slug
// (Demucs legacy, conservés en lecture seule cf D4=b).
async function listLegacyStems(env, slug) {
  if (!env.MASTERHUB_HISTORY) return [];
  const out = [];
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_HISTORY.list({ prefix: 'stems:', cursor, limit: 1000 });
    } catch { return out; }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_HISTORY.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) {
      if (
        v && v.id && v.status === 'success' &&
        v.r2Keys && typeof v.r2Keys === 'object' &&
        Array.isArray(v.assignedTo) && v.assignedTo.includes(slug)
      ) {
        const tsMs = v.ts ? new Date(v.ts).getTime() : 0;
        out.push({
          id: v.id,
          title: v.title || v.originalFilename || 'Sans titre',
          type: 'multitrack',
          durationSeconds: v.durationS || 0,
          sizeBytes: Math.round((v.sizeMB || 0) * 1024 * 1024),
          mimeType: 'audio/mpeg',
          uploadedAt: Number.isFinite(tsMs) ? tsMs : 0,
          status: 'success',
          stems: Object.keys(v.r2Keys),
          streamUrl: null, // legacy n'a pas de "original" R2 séparé
          trackUrlPrefix: `/api/stems/${encodeURIComponent(v.id)}/audio/`,
          legacy: true,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!await isValidSlug(slug, env)) return jsonResponse({ error: 'invalid_slug' }, 400);

  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const [newItems, legacyItems] = await Promise.all([
    listNewAnalyses(env, slug),
    listLegacyStems(env, slug),
  ]);

  const merged = [...newItems, ...legacyItems];
  merged.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  return jsonResponse({ ok: true, items: merged });
}
