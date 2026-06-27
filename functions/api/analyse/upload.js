// ─── POST /api/analyse/upload ────────────────────────────────────
// Upload admin d'un fichier audio (mp3/wav/m4a/flac).
//
// Multipart : 1 file + 1 title + (optionnel) duration_sec + pianoSolo (bool).
//
// Pipeline :
//   1. Auth admin + validation MIME audio + size + duration
//   2. R2.put analyse/<id>/original.<ext>
//   3a. Si pianoSolo=true → save KV type='single' status='success' → 201
//   3b. Sinon → check cap mensuel → trigger Replicate → save KV type='multitrack'
//       status='pending' avec replicateId → 201 { id, predictionId }
//       Le client doit ensuite poller /api/analyse?action=status&id=<>&predictionId=<>
//       qui finalise les stems R2 + update KV à 'success' quand Replicate termine.

import { requireAdminPassword, signReplicateToken } from '../_lib/session.js';
import {
  MIME_TYPES_ALLOWED, EXTENSION_BY_MIME, MAX_SIZE_BYTES, MAX_DURATION_S,
  MONTHLY_CAP, REPLICATE_VERSION, DEMUCS_MODEL, COST_EUR_PER_RUN,
  genId, slugify, CORS, jsonResponse, countMonthlyMultitrack,
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

  // Flag pianoSolo : "true"|"1" (form-encoded) → bypass Demucs
  const pianoSoloRaw = formData.get('pianoSolo');
  const pianoSolo = pianoSoloRaw === 'true' || pianoSoloRaw === '1' || pianoSoloRaw === true;

  // ── Cap mensuel multitrack ──
  if (!pianoSolo) {
    const used = await countMonthlyMultitrack(env);
    if (used >= MONTHLY_CAP) {
      return jsonResponse({
        error: 'monthly_cap_reached',
        cap: MONTHLY_CAP, count: used,
      }, 429);
    }
  }

  // ── R2 put original ──
  const id = genId();
  const ext = EXTENSION_BY_MIME[mimeType] || 'bin';
  const r2KeyOriginal = `analyse/${id}/original.${ext}`;
  const originalFilename = String(formData.get('filename') || (file.name || '')).slice(0, 200);

  try {
    await env.ANALYSE_R2.put(r2KeyOriginal, file.stream(), {
      httpMetadata: { contentType: mimeType },
    });
  } catch (e) {
    return jsonResponse({ error: 'r2_put_failed', detail: e?.message || '' }, 500);
  }

  // ── Construction du record commun ──
  const baseRecord = {
    id,
    title: titleRaw,
    type: pianoSolo ? 'single' : 'multitrack',
    originalFilename,
    r2KeyOriginal,
    r2KeysStems: null,
    mimeType,
    sizeBytes,
    durationSeconds,
    assignedTo: [],
    uploadedAt: Date.now(),
    uploadedBy: 'admin',
    status: pianoSolo ? 'success' : 'pending',
  };

  // ── Mode single : direct save, pas de Replicate ──
  if (pianoSolo) {
    try {
      await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(baseRecord));
    } catch (e) {
      try { await env.ANALYSE_R2.delete(r2KeyOriginal); } catch {}
      return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
    }
    return jsonResponse({
      ok: true, id, type: 'single',
      title: baseRecord.title, r2KeyOriginal, durationSeconds, sizeBytes,
    }, 201);
  }

  // ── Mode multitrack : trigger Replicate htdemucs_6s ──
  if (!env.REPLICATE_API_TOKEN) {
    try { await env.ANALYSE_R2.delete(r2KeyOriginal); } catch {}
    return jsonResponse({ error: 'replicate_token_missing' }, 502);
  }

  // Replicate télécharge l'audio source via une URL https publique signée
  // (token HMAC court vers l'original R2 déjà uploadé). On évite ainsi
  // d'encoder le fichier entier en dataURL base64 en mémoire (OOM possible
  // sur les gros multitrack, jusqu'à 100MB).
  const token = await signReplicateToken(env, id, 30 * 60);
  const origin = new URL(request.url).origin;
  const audioUrl = `${origin}/api/analyse/${id}/stream?t=${encodeURIComponent(token)}`;

  let replicateResp, replicateData;
  try {
    replicateResp = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: REPLICATE_VERSION,
        input: {
          audio: audioUrl,
          model: DEMUCS_MODEL,
          output_format: 'mp3',
          mp3_bitrate: 320,
        },
      }),
    });
    replicateData = await replicateResp.json();
  } catch (e) {
    try { await env.ANALYSE_R2.delete(r2KeyOriginal); } catch {}
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  if (!replicateResp.ok) {
    try { await env.ANALYSE_R2.delete(r2KeyOriginal); } catch {}
    return jsonResponse({
      error: 'replicate_error',
      detail: replicateData?.detail || replicateData,
    }, 502);
  }

  // Save KV pending avec replicateId pour le polling client
  baseRecord.replicateId = replicateData.id;
  baseRecord.costEUR = COST_EUR_PER_RUN; // optimiste, sera décompté en cas de fail
  try {
    await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(baseRecord));
  } catch (e) {
    try { await env.ANALYSE_R2.delete(r2KeyOriginal); } catch {}
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({
    ok: true, id, type: 'multitrack',
    title: baseRecord.title, r2KeyOriginal, durationSeconds, sizeBytes,
    predictionId: replicateData.id,
    status: 'pending',
  }, 201);
}
