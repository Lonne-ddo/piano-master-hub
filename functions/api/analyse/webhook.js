// ─── POST /api/analyse/webhook?id=<>&t=<token> ───────────────────
// Webhook Replicate (events_filter: ['completed']). Finalise la séparation
// multitrack server-side, indépendamment du polling client : si l'onglet admin
// est fermé ou le run dépasse 10 min, le record n'est plus bloqué en pending.
//
// Auth : pas de cookie (c'est Replicate qui appelle). On vérifie le token URL
// signé (verifyReplicateToken) émis à l'upload — cohérent avec le token de
// stream. Pas de gestion de la signature Replicate officielle (risque faible).
//
// Idempotent : si le record n'est plus 'pending' (déjà finalisé par le poll
// client ou un retry webhook), on répond 200 sans rien faire. Répond TOUJOURS
// 200 sur appel authentifié pour éviter les retries Replicate inutiles.

import { verifyReplicateToken } from '../_lib/session.js';
import { isValidId, finalizeSeparation, jsonResponse, CORS } from './_helpers.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.MASTERHUB_ANALYSE) return jsonResponse({ error: 'kv_not_bound' }, 500);
  if (!env.ANALYSE_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '');
  const t = String(url.searchParams.get('t') || '');

  if (!isValidId(id)) return jsonResponse({ error: 'bad_id' }, 400);
  if (!(await verifyReplicateToken(env, id, t))) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  // Body = la prédiction Replicate complète (status + output).
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: true, ignored: 'bad_body' }, 200);
  }

  let record;
  try {
    record = await env.MASTERHUB_ANALYSE.get(`analyse:${id}`, { type: 'json' });
  } catch {
    return jsonResponse({ ok: true, ignored: 'kv_get_failed' }, 200);
  }

  // Record absent ou déjà finalisé → 200 idempotent (ne pas re-traiter).
  if (!record || record.status !== 'pending') {
    return jsonResponse({ ok: true, idempotent: true }, 200);
  }

  if (body?.status === 'succeeded') {
    await finalizeSeparation(env, id, record, body);
    return jsonResponse({ ok: true }, 200);
  }

  if (body?.status === 'failed' || body?.status === 'canceled') {
    record.status = 'failed';
    record.errorCode = `replicate_${body.status}`;
    record.costEUR = 0;
    try {
      await env.MASTERHUB_ANALYSE.put(`analyse:${id}`, JSON.stringify(record));
    } catch (e) { /* non-bloquant */ }
    return jsonResponse({ ok: true }, 200);
  }

  // Statut intermédiaire inattendu (filter='completed' ne devrait pas en envoyer).
  return jsonResponse({ ok: true, ignored: body?.status || 'unknown' }, 200);
}
