// ─── GET /api/analyse/status?id=<>&predictionId=<> ──────────────
// Poll Replicate pour un upload type='multitrack' status='pending'.
// Quand Replicate succeeded : fetch les 6 stems → upload R2 → update KV
// status='success' + r2KeysStems peuplé. Idempotent (re-appels OK).
//
// Auth : admin (cookie mh_admin_pw).

import { requireAdminPassword } from '../_lib/session.js';
import {
  finalizeSeparation, isValidId, jsonResponse, CORS,
} from './_helpers.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.ANALYSE_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);
  if (!env.REPLICATE_API_TOKEN) return jsonResponse({ error: 'replicate_token_missing' }, 502);

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '');
  const predictionId = String(url.searchParams.get('predictionId') || '').trim();

  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);
  if (!/^[a-zA-Z0-9]+$/.test(predictionId) || predictionId.length > 64) {
    return jsonResponse({ error: 'bad_prediction_id' }, 400);
  }

  // Lookup KV
  let record;
  try {
    record = await env.MASTERHUB_ANALYSE.get(`analyse:${id}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_get_failed', detail: e?.message || '' }, 500);
  }
  if (!record) return jsonResponse({ error: 'not_found' }, 404);

  // Idempotence : si déjà success, on retourne tel quel
  if (record.status === 'success') {
    return jsonResponse({ ok: true, status: 'success', record });
  }
  if (record.status === 'failed') {
    return jsonResponse({ ok: true, status: 'failed', record });
  }

  // Poll Replicate
  let resp, data;
  try {
    resp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
    });
    data = await resp.json();
  } catch (e) {
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  if (data?.status === 'starting' || data?.status === 'processing') {
    return jsonResponse({
      ok: true, status: 'pending',
      replicateStatus: data.status,
      logs: typeof data.logs === 'string' ? data.logs.slice(-500) : null,
    });
  }

  if (data?.status === 'failed' || data?.status === 'canceled') {
    record.status = 'failed';
    record.errorCode = `replicate_${data.status}`;
    record.costEUR = 0;
    try {
      await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(record));
    } catch (e) { /* non-bloquant */ }
    return jsonResponse({
      ok: true, status: 'failed',
      detail: data?.error || `Replicate ${data.status}`,
    });
  }

  if (data?.status !== 'succeeded') {
    return jsonResponse({ ok: true, status: 'pending', replicateStatus: data?.status });
  }

  // ── Succeeded : finalisation partagée (stems → R2 → KV) ──
  // Même logique que le webhook server-side. Sur output_expired → 'failed'
  // (plus de boucle pending infinie quand l'output Replicate a expiré).
  const result = await finalizeSeparation(env, id, record, data);
  if (result.status === 'success') {
    return jsonResponse({ ok: true, status: 'success', record: result.record });
  }
  if (result.status === 'failed') {
    return jsonResponse({ ok: true, status: 'failed', detail: result.detail });
  }
  return jsonResponse({ ok: true, status: 'pending', detail: result.detail });
}
