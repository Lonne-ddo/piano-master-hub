// ─── POST /api/analyse/upload ────────────────────────────────────
// Upload admin d'une vidéo pédagogique d'analyse.
// Multipart : 1 file + 1 title + (optionnel) duration_sec.
//
// Pipeline :
//   1. Auth admin (mh_admin_pw)
//   2. Validation MIME (video/mp4|webm|quicktime), taille (≤100MB), durée (≤30min)
//   3. R2 put : analyse/<id>/<slug-titre>.<ext>
//   4. KV write : analyse:<id> avec record canonique
//   5. Retour { id, title, r2Key, durationSeconds }

import { requireAdminPassword } from '../_lib/session.js';
import {
  MIME_TYPES_ALLOWED, EXTENSION_BY_MIME, MAX_SIZE_BYTES, MAX_DURATION_S,
  genId, slugify, CORS, jsonResponse,
} from './_helpers.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.ANALYSE_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);

  let formData;
  try { formData = await request.formData(); }
  catch (e) {
    return jsonResponse({ error: 'invalid_multipart', detail: e?.message || '' }, 400);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string' || !(file instanceof File || file instanceof Blob)) {
    return jsonResponse({ error: 'file_missing' }, 400);
  }

  const titleRaw = String(formData.get('title') || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!titleRaw || titleRaw.length > 200) {
    return jsonResponse({ error: 'title_invalid', detail: 'requis 1-200 chars' }, 400);
  }

  const mimeType = file.type;
  if (!MIME_TYPES_ALLOWED.includes(mimeType)) {
    return jsonResponse({
      error: 'mime_not_allowed',
      mimeType,
      allowed: MIME_TYPES_ALLOWED,
    }, 415);
  }

  const sizeBytes = file.size || 0;
  if (sizeBytes <= 0) return jsonResponse({ error: 'file_empty' }, 400);
  if (sizeBytes > MAX_SIZE_BYTES) {
    return jsonResponse({
      error: 'file_too_large',
      sizeBytes, maxBytes: MAX_SIZE_BYTES,
    }, 413);
  }

  // duration_sec passé en field depuis le client (lecture <video>.duration côté front).
  // 0 ou absent → on enregistre 0 ; le front gère le rendu fallback.
  const durationRaw = Number(formData.get('duration_sec') || 0);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0
    ? Math.round(durationRaw)
    : 0;
  if (durationSeconds > MAX_DURATION_S) {
    return jsonResponse({
      error: 'duration_too_long',
      durationSeconds, maxSeconds: MAX_DURATION_S,
    }, 422);
  }

  const id = genId();
  const ext = EXTENSION_BY_MIME[mimeType];
  const slug = slugify(titleRaw) || 'video';
  const r2Key = `analyse/${id}/${slug}.${ext}`;
  const originalFilename = String(formData.get('filename') || (file.name || '')).slice(0, 200);

  // Stream → R2 (file.stream() ou file directement, l'API CF accepte les Blob)
  try {
    await env.ANALYSE_R2.put(r2Key, file.stream(), {
      httpMetadata: { contentType: mimeType },
    });
  } catch (e) {
    return jsonResponse({ error: 'r2_put_failed', detail: e?.message || '' }, 500);
  }

  const record = {
    id,
    title: titleRaw,
    originalFilename,
    r2Key,
    mimeType,
    sizeBytes,
    durationSeconds,
    assignedTo: [],
    uploadedAt: Date.now(),
    uploadedBy: 'admin',
  };

  try {
    await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(record));
  } catch (e) {
    // KV échoue après R2 success → R2 cleanup best-effort pour éviter orphelin
    try { await env.ANALYSE_R2.delete(r2Key); } catch {}
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({
    ok: true, id, title: record.title, r2Key, durationSeconds, sizeBytes,
  }, 201);
}
