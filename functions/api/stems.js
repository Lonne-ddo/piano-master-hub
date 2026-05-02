// ─── /api/stems ─────────────────────────────────────────────────
// Séparation de pistes Demucs via Replicate (admin only).
//
// Routes (dispatch via ?action=) :
//   POST /api/stems?action=predict  body: { audio: dataURL, filename, duration }
//                                   → { id, status, ... } (Replicate prediction)
//   GET  /api/stems?action=status&id=<>&filename=<>&duration=<>&size=<>
//                                   → { status, output, ... } + log final si terminé
//
// Auth : super-admin via session cookie uniquement (magic link → is_admin === true).
// Aucune autre porte d'entrée (pas de header secret, pas de query token).
//
// Logging : un seul log final par run dans MASTERHUB_HISTORY (TTL 90j),
// déduplication via clé tag `stems:tag:<predictionId>`.
//   - status === 'success'  : run réussi (compte pour les coûts)
//   - status === 'failed'   : Replicate refuse (4xx/5xx) ou prediction failed/canceled

import { getSessionFromRequest, isAdminEmail } from './_lib/session.js';

// ─── Constantes ────────────────────────────────────────────────
const REPLICATE_VERSION = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const DEMUCS_MODEL = 'htdemucs'; // 4 stems : vocals/drums/bass/other (modèle PianoKey)
const MAX_SIZE_MB = 50;
const MAX_DURATION_S = 900; // 15 min
const COST_EUR_PER_RUN = 0.02;
const KV_LOG_TTL_S = 90 * 24 * 3600; // 90j
const KV_TAG_TTL_S = 24 * 3600;      // 24h (dédup polling)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ─── Auth super-admin (session cookie + isAdminEmail) ──────────
async function requireAdmin(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (!session || !session.is_admin) return null;
  // Defense in depth : si l'email a été retiré de ADMIN_EMAILS depuis la
  // création de la session, on refuse même avec un cookie valide.
  if (!isAdminEmail(session.email, env)) return null;
  return session;
}

// ─── Logging KV ────────────────────────────────────────────────
function buildLogKey(predictionId) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ts = now.getTime();
  // randomId déterministe par predictionId pour idempotence (re-poll écrase la clé)
  // — ou random pur si pas d'id (fail avant id). On préfère predictionId si dispo.
  if (predictionId) return `stems:${ym}:${ts}-${predictionId}`;
  const rid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `stems:${ym}:${ts}-${rid}`;
}

async function isAlreadyLogged(env, predictionId) {
  if (!predictionId || !env.MASTERHUB_HISTORY) return false;
  try {
    const tag = await env.MASTERHUB_HISTORY.get(`stems:tag:${predictionId}`);
    return !!tag;
  } catch { return false; }
}

async function markLogged(env, predictionId) {
  if (!predictionId || !env.MASTERHUB_HISTORY) return;
  try {
    await env.MASTERHUB_HISTORY.put(`stems:tag:${predictionId}`, '1', {
      expirationTtl: KV_TAG_TTL_S,
    });
  } catch { /* non-bloquant */ }
}

async function writeLog(env, payload) {
  if (!env.MASTERHUB_HISTORY) return;
  try {
    const key = buildLogKey(payload.replicateId);
    await env.MASTERHUB_HISTORY.put(key, JSON.stringify(payload), {
      expirationTtl: KV_LOG_TTL_S,
    });
  } catch (e) {
    console.warn('[stems] log KV put failed:', e?.message || e);
  }
}

// ─── Dispatch ──────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;

  const session = await requireAdmin(request, env);
  if (!session) return jsonResponse({ error: 'unauthorized' }, 401);

  if (!env.REPLICATE_API_TOKEN) {
    return jsonResponse({ error: 'replicate_token_missing' }, 502);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'predict' && request.method === 'POST') {
    return handlePredict(request, env, session);
  }
  if (action === 'status' && request.method === 'GET') {
    return handleStatus(request, env, session);
  }
  return jsonResponse({ error: 'invalid_action' }, 400);
}

// ─── Predict ───────────────────────────────────────────────────
async function handlePredict(request, env, session) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  if (!body?.audio || typeof body.audio !== 'string') {
    return jsonResponse({ error: 'audio_missing' }, 400);
  }

  // Approximation taille fichier original = base64Length × 0.75 (4 chars → 3 bytes)
  const sizeMB = (body.audio.length * 0.75) / (1024 * 1024);
  const filename = typeof body.filename === 'string' ? body.filename.slice(0, 200) : '';
  const durationS = (typeof body.duration === 'number' && body.duration > 0)
    ? Math.round(body.duration) : 0;

  if (sizeMB > MAX_SIZE_MB) {
    await writeLog(env, {
      ts: new Date().toISOString(),
      email: session.email,
      filename,
      durationS,
      sizeMB: Math.round(sizeMB * 10) / 10,
      status: 'failed',
      errorCode: 'size_limit',
      costEUR: 0,
      replicateId: null,
    });
    return jsonResponse({ error: 'file_too_large', maxMB: MAX_SIZE_MB }, 413);
  }

  if (durationS > MAX_DURATION_S) {
    await writeLog(env, {
      ts: new Date().toISOString(),
      email: session.email,
      filename,
      durationS,
      sizeMB: Math.round(sizeMB * 10) / 10,
      status: 'failed',
      errorCode: 'duration_limit',
      costEUR: 0,
      replicateId: null,
    });
    return jsonResponse({ error: 'duration_too_long', maxS: MAX_DURATION_S }, 422);
  }

  let replicateResp, data;
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
          audio: body.audio,
          model: DEMUCS_MODEL,
          output_format: 'mp3',
          mp3_bitrate: 320,
        },
      }),
    });
    data = await replicateResp.json();
  } catch (e) {
    await writeLog(env, {
      ts: new Date().toISOString(),
      email: session.email,
      filename,
      durationS,
      sizeMB: Math.round(sizeMB * 10) / 10,
      status: 'failed',
      errorCode: 'replicate_network',
      costEUR: 0,
      replicateId: null,
    });
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  if (!replicateResp.ok) {
    await writeLog(env, {
      ts: new Date().toISOString(),
      email: session.email,
      filename,
      durationS,
      sizeMB: Math.round(sizeMB * 10) / 10,
      status: 'failed',
      errorCode: `replicate_${replicateResp.status}`,
      costEUR: 0,
      replicateId: data?.id || null,
    });
    return jsonResponse({ error: 'replicate_error', detail: data?.detail || data }, 502);
  }

  // Replicate a accepté la prédiction — pas de log encore. Le log final est
  // écrit par handleStatus quand le polling client atteint un statut terminal.
  return jsonResponse(data, 201);
}

// ─── Status ────────────────────────────────────────────────────
async function handleStatus(request, env, session) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(id) || id.length > 64) {
    return jsonResponse({ error: 'bad_id' }, 400);
  }

  // Metadata renvoyée par le client à chaque poll (idempotent — on log 1 seule fois)
  const filename = String(url.searchParams.get('filename') || '').slice(0, 200);
  const durationS = parseInt(url.searchParams.get('duration') || '0', 10) || 0;
  const sizeMB = parseFloat(url.searchParams.get('size') || '0') || 0;

  let resp, data;
  try {
    resp = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
    });
    data = await resp.json();
  } catch (e) {
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  // Statut terminal → log final (déduplication via tag KV)
  if (data?.status === 'succeeded' || data?.status === 'failed' || data?.status === 'canceled') {
    if (!(await isAlreadyLogged(env, id))) {
      const isSuccess = data.status === 'succeeded';
      await writeLog(env, {
        ts: new Date().toISOString(),
        email: session.email,
        filename,
        durationS,
        sizeMB: Math.round(sizeMB * 10) / 10,
        status: isSuccess ? 'success' : 'failed',
        errorCode: isSuccess ? undefined : `replicate_${data.status}`,
        costEUR: isSuccess ? COST_EUR_PER_RUN : 0,
        replicateId: id,
      });
      await markLogged(env, id);
    }
  }

  return jsonResponse(data, resp.status);
}
