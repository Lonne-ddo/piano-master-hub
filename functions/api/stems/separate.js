// ─── POST /api/stems/separate ────────────────────────────────────
// Lance une séparation Demucs (htdemucs_6s : vocals/drums/bass/other/piano/guitar)
// via Replicate. Auth super-admin (session cookie OU x-admin-secret).
//
// Body : { audio: "data:audio/mp3;base64,...", filename?: string, duration?: number }
// Réponse : { id, status, ... } (Replicate prediction object)
//
// Logs : un événement est écrit dans MASTERHUB_HISTORY (clé `stems:<ts>`)
// pour permettre le suivi des coûts mensuels.

import { getSessionFromRequest } from '../_lib/session.js';

// Modèle Replicate cjwbw/demucs (même version que piano-key, htdemucs_6s ajoute piano + guitar)
const REPLICATE_VERSION = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const DEMUCS_MODEL = 'htdemucs_6s';

// Limites de garde-fou (côté serveur, indépendantes du frontend)
const MAX_BODY_BYTES   = 70 * 1024 * 1024; // ~50 MB de fichier après base64 (×1.37)
const MAX_DURATION_SEC = 15 * 60;          // 15 min max

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function requireAdmin(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (session?.is_admin) return { ok: true, email: session.email || null };

  const secret = request.headers.get('x-admin-secret');
  if (secret && env.ADMIN_SECRET && secret === env.ADMIN_SECRET) {
    return { ok: true, email: 'legacy-admin' };
  }
  return { ok: false };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!env.REPLICATE_API_TOKEN) {
    return jsonResponse({ error: 'REPLICATE_API_TOKEN missing in CF Pages env' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body?.audio || typeof body.audio !== 'string') {
    return jsonResponse({ error: 'Champ "audio" (data URL base64) requis' }, 400);
  }
  if (body.audio.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Fichier trop volumineux (max 50 Mo)' }, 413);
  }
  if (typeof body.duration === 'number' && body.duration > MAX_DURATION_SEC) {
    return jsonResponse({ error: `Morceau trop long (max ${MAX_DURATION_SEC / 60} min)` }, 413);
  }

  const replicateResp = await fetch('https://api.replicate.com/v1/predictions', {
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

  const data = await replicateResp.json();

  // Log uniquement si la prédiction a bien démarré (id présent)
  if (replicateResp.ok && data?.id && env.MASTERHUB_HISTORY) {
    const ts = Date.now();
    const logKey = `stems:${ts}:${data.id}`;
    const logValue = {
      ts,
      ts_iso: new Date(ts).toISOString(),
      prediction_id: data.id,
      admin_email: auth.email,
      filename: typeof body.filename === 'string' ? body.filename.slice(0, 200) : null,
      duration_sec: typeof body.duration === 'number' ? Math.round(body.duration) : null,
      model: DEMUCS_MODEL,
    };
    try {
      // TTL 90 jours — assez pour suivi des coûts mensuels
      await env.MASTERHUB_HISTORY.put(logKey, JSON.stringify(logValue), {
        expirationTtl: 90 * 24 * 3600,
      });
    } catch (e) {
      // Non-bloquant — la séparation continue même si le log échoue
      console.warn('[stems/separate] log KV put failed:', e?.message || e);
    }
  }

  return jsonResponse(data, replicateResp.status);
}
