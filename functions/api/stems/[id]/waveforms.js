// ─── /api/stems/:id/waveforms ────────────────────────────────────
// Cache R2 des peaks pré-calculés (côté client) pour accélérer le rendu
// des waveforms à chaque ouverture du player.
//
// GET  → admin OR élève dans assignedTo. Retourne le JSON depuis R2.
//        404 si pas encore calculé (le client déclenchera le calcul + POST).
// POST → admin OR élève dans assignedTo. Body { peaks: { vocals: [...], ... } }.
//        Stocke dans R2 stems/<id>/waveforms.json.
//
// Format peaks : { stem: number[] } où chaque array est ~1000-4000 valeurs
// normalisées dans [0,1]. Validation stricte côté serveur (anti-pollution R2).

import { requireAdminPassword, getSessionFromRequest } from '../../_lib/session.js';

const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];
const MAX_PEAKS_PER_STEM = 8000;
const MIN_PEAKS_PER_STEM = 50;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isValidSeparationId(id) {
  return typeof id === 'string' && /^\d{10,16}-[A-Za-z0-9]{4,16}$/.test(id);
}

async function findEntry(env, separationId) {
  const ts = parseInt(separationId.split('-')[0], 10);
  if (!Number.isFinite(ts)) return null;
  const date = new Date(ts);
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const key = `stems:${ym}:${separationId}`;
  try {
    const entry = await env.MASTERHUB_HISTORY.get(key, { type: 'json' });
    return entry || null;
  } catch { return null; }
}

// Auth : admin (mh_admin_pw) OR élève dans assignedTo de la séparation.
async function authorizeAccess(request, env, entry) {
  if (await requireAdminPassword(request, env)) return true;
  const session = await getSessionFromRequest(request, env);
  const assigned = Array.isArray(entry.assignedTo) ? entry.assignedTo : [];
  return !!(session?.slug && assigned.includes(session.slug));
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ─── GET ────────────────────────────────────────────────────────
export async function onRequestGet({ params, request, env }) {
  if (!env.STEMS_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const entry = await findEntry(env, id);
  if (!entry || entry.status !== 'success') return jsonResponse({ error: 'not_found' }, 404);

  if (!(await authorizeAccess(request, env, entry))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const r2Key = `stems/${id}/waveforms.json`;
  let r2Object;
  try {
    r2Object = await env.STEMS_R2.get(r2Key);
  } catch (e) {
    return jsonResponse({ error: 'r2_get_failed', detail: e?.message || '' }, 500);
  }
  if (!r2Object) return jsonResponse({ error: 'not_calculated' }, 404);

  const text = await r2Object.text();
  return new Response(text, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

// ─── POST ───────────────────────────────────────────────────────
export async function onRequestPost({ params, request, env }) {
  if (!env.STEMS_R2) return jsonResponse({ error: 'r2_not_bound' }, 500);
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const id = String(params?.id || '');
  if (!isValidSeparationId(id)) return jsonResponse({ error: 'bad_id' }, 400);

  const entry = await findEntry(env, id);
  if (!entry || entry.status !== 'success') return jsonResponse({ error: 'not_found' }, 404);

  if (!(await authorizeAccess(request, env, entry))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const peaksRaw = body?.peaks;
  if (!peaksRaw || typeof peaksRaw !== 'object' || Array.isArray(peaksRaw)) {
    return jsonResponse({ error: 'peaks_object_required' }, 400);
  }

  // Validation : pour chaque stem présent, l'array doit contenir des nombres
  // dans [0,1] et avoir une taille raisonnable. Filtre les keys non-canoniques.
  const peaks = {};
  for (const stem of STEM_KEYS) {
    const arr = peaksRaw[stem];
    if (!Array.isArray(arr)) continue;
    if (arr.length < MIN_PEAKS_PER_STEM || arr.length > MAX_PEAKS_PER_STEM) {
      return jsonResponse(
        { error: 'peaks_size_invalid', stem, min: MIN_PEAKS_PER_STEM, max: MAX_PEAKS_PER_STEM },
        400,
      );
    }
    // Normalize + clamp à [0,1]
    const sanitized = arr.map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      if (n < 0) return 0;
      if (n > 1) return 1;
      // Tronquer à 3 décimales pour réduire la taille du JSON
      return Math.round(n * 1000) / 1000;
    });
    peaks[stem] = sanitized;
  }

  if (Object.keys(peaks).length === 0) {
    return jsonResponse({ error: 'no_valid_stems' }, 400);
  }

  const r2Key = `stems/${id}/waveforms.json`;
  const payload = JSON.stringify({ peaks, ts: new Date().toISOString() });
  try {
    await env.STEMS_R2.put(r2Key, payload, {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    return jsonResponse({ error: 'r2_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, id, stems: Object.keys(peaks).sort() });
}
