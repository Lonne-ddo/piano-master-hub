// ─── /api/stems ─────────────────────────────────────────────────
// Séparation de pistes Demucs htdemucs_6s via Replicate.
//
// Routes (dispatch via ?action=) :
//   POST /api/stems?action=predict
//        body: { audio: dataURL, title?, filename, duration, sizeMB }
//        → { id, status, ... } (Replicate prediction)
//   GET  /api/stems?action=status&id=<>&title=<>&filename=<>&duration=<>&size=<>
//        → { status, output, ... }
//        Lorsque Replicate atteint 'succeeded', les 6 stems sont uploadés sur
//        R2 (binding STEMS_R2) et l'entrée KV est créée avec r2Keys+assignedTo.
//
// Auth : admin via cookie mh_admin_pw (HMAC stateless).
//
// Logging KV (MASTERHUB_HISTORY) :
//   - succès → clé `stems:<YYYY-MM>:<separationId>` (séparationId = ts-predIdShort)
//     value = { id, ts, title, originalFilename, durationS, sizeMB, status:'success',
//               costEUR, replicateId, r2Keys, assignedTo }
//     PAS de TTL (suppression manuelle via DELETE /api/stems/:id).
//   - échec → même schéma de clé mais sans r2Keys, status:'failed', errorCode,
//     TTL 90j (les échecs n'ont pas de stems à conserver).
//
// Cap : 20 séparations success / mois civil. Vérifié AVANT appel Replicate pour
// éviter de payer un run inutilement (sauf race condition rare entre 2 admins).

import { requireAdminPassword } from './_lib/session.js';

// ─── Constantes ────────────────────────────────────────────────
// Provider : ryan5453/demucs (fork moderne maintenu, schéma Output dynamique
// avec extra='allow' qui rend les fields correspondant au modèle choisi).
// Version 5a7041cc...= 1 an 4 mois — supporte natively htdemucs_6s à 6 stems.
const REPLICATE_VERSION = '5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77';
const DEMUCS_MODEL = 'htdemucs_6s'; // 6 stems : vocals/drums/bass/other/piano/guitar
const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];
const MAX_SIZE_MB = 50;
const MAX_DURATION_S = 900;     // 15 min
const MONTHLY_CAP = 20;
const COST_EUR_PER_RUN = 0.02;
const KV_FAILED_TTL_S = 90 * 24 * 3600;
const KV_TAG_TTL_S = 24 * 3600;

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

// ─── Helpers KV ────────────────────────────────────────────────
function ymString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildSeparationId(predictionId) {
  const ts = Date.now();
  const short = predictionId
    ? String(predictionId).slice(0, 8)
    : (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10));
  return `${ts}-${short}`;
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

async function writeFailed(env, predictionId, payload) {
  if (!env.MASTERHUB_HISTORY) return;
  const id = buildSeparationId(predictionId);
  const ym = ymString();
  const key = `stems:${ym}:${id}`;
  const value = {
    id,
    ts: new Date().toISOString(),
    title: payload.title || '',
    originalFilename: payload.filename || '',
    durationS: payload.durationS || 0,
    sizeMB: payload.sizeMB || 0,
    status: 'failed',
    errorCode: payload.errorCode,
    costEUR: 0,
    replicateId: predictionId || null,
  };
  try {
    await env.MASTERHUB_HISTORY.put(key, JSON.stringify(value), {
      expirationTtl: KV_FAILED_TTL_S,
    });
  } catch (e) {
    console.warn('[stems] failed-log KV put failed:', e?.message || e);
  }
}

// Compte les success du mois courant (cap 20). Prefix scan KV.
async function countSuccessThisMonth(env) {
  if (!env.MASTERHUB_HISTORY) return 0;
  const prefix = `stems:${ymString()}:`;
  let count = 0;
  let cursor;
  while (true) {
    let page;
    try {
      page = await env.MASTERHUB_HISTORY.list({ prefix, cursor, limit: 1000 });
    } catch { return count; }
    const values = await Promise.all(
      page.keys.map((k) =>
        env.MASTERHUB_HISTORY.get(k.name, { type: 'json' }).catch(() => null),
      ),
    );
    for (const v of values) if (v?.status === 'success') count++;
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return count;
}

// ─── Dispatch ──────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.REPLICATE_API_TOKEN) {
    return jsonResponse({ error: 'replicate_token_missing' }, 502);
  }
  if (!env.STEMS_R2) {
    return jsonResponse({ error: 'r2_not_bound' }, 500);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'predict' && request.method === 'POST') {
    return handlePredict(request, env);
  }
  if (action === 'status' && request.method === 'GET') {
    return handleStatus(request, env);
  }
  return jsonResponse({ error: 'invalid_action' }, 400);
}

// ─── Predict ───────────────────────────────────────────────────
async function handlePredict(request, env) {
  // Cap mensuel AVANT Replicate (évite de payer un run inutile)
  const used = await countSuccessThisMonth(env);
  if (used >= MONTHLY_CAP) {
    return jsonResponse(
      { error: 'monthly_cap_reached', cap: MONTHLY_CAP, count: used },
      429,
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  if (!body?.audio || typeof body.audio !== 'string') {
    return jsonResponse({ error: 'audio_missing' }, 400);
  }

  // Extraction des metas (cf. spec POST predict)
  const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '';
  const filename = typeof body.filename === 'string' ? body.filename.slice(0, 200) : '';
  const durationS = (typeof body.duration === 'number' && body.duration > 0)
    ? Math.round(body.duration) : 0;
  // sizeMB envoyé par le client ; recoupe avec longueur base64 pour défense en profondeur
  const sizeFromB64 = (body.audio.length * 0.75) / (1024 * 1024);
  const sizeMB = Math.max(
    Number(body.sizeMB) || 0,
    Math.round(sizeFromB64 * 10) / 10,
  );

  if (sizeMB > MAX_SIZE_MB) {
    await writeFailed(env, null, { title, filename, durationS, sizeMB, errorCode: 'size_limit' });
    return jsonResponse({ error: 'file_too_large', maxMB: MAX_SIZE_MB }, 413);
  }
  if (durationS > MAX_DURATION_S) {
    await writeFailed(env, null, { title, filename, durationS, sizeMB, errorCode: 'duration_limit' });
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
    await writeFailed(env, null, { title, filename, durationS, sizeMB, errorCode: 'replicate_network' });
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  if (!replicateResp.ok) {
    await writeFailed(env, data?.id, { title, filename, durationS, sizeMB, errorCode: `replicate_${replicateResp.status}` });
    return jsonResponse({ error: 'replicate_error', detail: data?.detail || data }, 502);
  }

  // Replicate a accepté la prédiction. Pas de log encore — le log final +
  // upload R2 est écrit par handleStatus quand le polling client atteint
  // succeeded (idempotent via stems:tag:<predId>).
  return jsonResponse(data, 201);
}

// ─── Status ────────────────────────────────────────────────────
async function handleStatus(request, env) {
  const url = new URL(request.url);
  const predId = (url.searchParams.get('id') || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(predId) || predId.length > 64) {
    return jsonResponse({ error: 'bad_id' }, 400);
  }

  // Métadonnées renvoyées par le client à chaque poll (idempotent : on log 1x)
  const title = String(url.searchParams.get('title') || '').slice(0, 80);
  const filename = String(url.searchParams.get('filename') || '').slice(0, 200);
  const durationS = parseInt(url.searchParams.get('duration') || '0', 10) || 0;
  const sizeMB = parseFloat(url.searchParams.get('size') || '0') || 0;

  let resp, data;
  try {
    resp = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
    });
    data = await resp.json();
  } catch (e) {
    return jsonResponse({ error: 'replicate_unreachable', detail: e?.message || '' }, 502);
  }

  if (data?.status === 'succeeded') {
    if (!(await isAlreadyLogged(env, predId))) {
      // Upload R2 + write KV (idempotent via tag KV ; tag posé seulement après
      // succès complet — un timeout côté CF sera retried au prochain poll client).
      const stemUrls = normalizeOutput(data.output);
      const presentKeys = STEM_KEYS.filter((k) => stemUrls[k]);
      if (!presentKeys.length) {
        // Replicate a renvoyé un output vide → on log failed et on tag.
        await writeFailed(env, predId, {
          title, filename, durationS, sizeMB, errorCode: 'empty_output',
        });
        await markLogged(env, predId);
        return jsonResponse(data, resp.status);
      }

      const separationId = buildSeparationId(predId);
      const r2Keys = {};
      try {
        await Promise.all(presentKeys.map(async (stem) => {
          const stemUrl = stemUrls[stem];
          const r2Key = `stems/${separationId}/${stem}.mp3`;
          const fetchResp = await fetch(stemUrl);
          if (!fetchResp.ok) {
            throw new Error(`fetch_${stem}_${fetchResp.status}`);
          }
          await env.STEMS_R2.put(r2Key, fetchResp.body, {
            httpMetadata: { contentType: 'audio/mpeg' },
          });
          r2Keys[stem] = r2Key;
        }));
      } catch (e) {
        console.warn('[stems] R2 upload failed:', e?.message || e);
        // Pas de tag posé → retry possible au prochain poll. On retourne quand
        // même le statut Replicate au client (qui continuera à poller).
        return jsonResponse(data, resp.status);
      }

      const ym = ymString();
      const key = `stems:${ym}:${separationId}`;
      // outputShape : keys reçues de Replicate, triées. Sert de diag pour
      // détecter un futur silently-fallback du modèle (ex : si seulement
      // ['bass','drums','other','vocals'] au lieu de 6).
      const outputShape = {
        rawType: Array.isArray(data.output) ? 'array' : typeof data.output,
        rawLength: Array.isArray(data.output) ? data.output.length : null,
        normalizedKeys: Object.keys(stemUrls).sort(),
        uploadedKeys: presentKeys.slice().sort(),
      };
      const entry = {
        id: separationId,
        ts: new Date().toISOString(),
        title,
        originalFilename: filename,
        durationS,
        sizeMB,
        status: 'success',
        costEUR: COST_EUR_PER_RUN,
        replicateId: predId,
        r2Keys,
        outputShape,
        assignedTo: [],
      };
      try {
        // Pas d'expirationTtl — les success sont conservés jusqu'à DELETE manuel.
        await env.MASTERHUB_HISTORY.put(key, JSON.stringify(entry));
      } catch (e) {
        console.warn('[stems] KV success write failed:', e?.message || e);
        // R2 upload a réussi mais KV a échoué — retry au prochain poll. On
        // pourrait avoir des objets R2 orphelins, mais c'est acceptable pour
        // un cas extrêmement rare.
        return jsonResponse(data, resp.status);
      }

      await markLogged(env, predId);
    }
  } else if (data?.status === 'failed' || data?.status === 'canceled') {
    if (!(await isAlreadyLogged(env, predId))) {
      await writeFailed(env, predId, {
        title, filename, durationS, sizeMB,
        errorCode: `replicate_${data.status}`,
      });
      await markLogged(env, predId);
    }
  }

  return jsonResponse(data, resp.status);
}

// Replicate htdemucs_6s retourne typiquement un objet { vocals, drums, ... }.
// On supporte aussi un array (legacy), mappé sur l'ordre canonique demucs.
function normalizeOutput(output) {
  if (!output) return {};
  if (Array.isArray(output)) {
    // htdemucs_6s order: vocals, drums, bass, other, piano, guitar
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
