// ─── /api/eleves/:slug/roadmap ───────────────────────────────────
// Admin uniquement (cookie mh_admin_pw).
// GET   → { roadmap, persisted, templates, seances } : roadmap de l'élève
//         (parcours "general" déduit de nb_cours si jamais enregistrée),
//         modèles de parcours et historique des séances saisies.
// PATCH → body { parcours, seances[8] } : remplace la roadmap de l'élève
//         (les modèles ne sont jamais modifiés). nb_cours = séances faites.

import { requireAdminPassword } from '../../_lib/session.js';
import {
  ROADMAP_TEMPLATES, ensureRoadmap, validateRoadmapInput, withRoadmap,
} from '../../_lib/roadmap.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function loadRecord(slug, env) {
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return { error: jsonResponse({ error: 'invalid_slug' }, 400) };
  const record = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  if (!record) return { error: jsonResponse({ error: 'Élève introuvable' }, 404) };
  return { record };
}

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  const slug = String(params.slug || '').toLowerCase();
  const { record, error } = await loadRecord(slug, env);
  if (error) return error;

  const seances = await env.MASTERHUB_STUDENTS.get(`seances:${slug}`, { type: 'json' }).catch(() => null);
  return jsonResponse({
    ok: true,
    roadmap: ensureRoadmap(record),
    persisted: !!record.roadmap,
    templates: ROADMAP_TEMPLATES,
    seances: Array.isArray(seances) ? seances : [],
  });
}

export async function onRequestPatch({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  const slug = String(params.slug || '').toLowerCase();

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }

  const { roadmap, error: vErr } = validateRoadmapInput(body);
  if (vErr) return jsonResponse({ error: vErr }, 400);

  const { record, error } = await loadRecord(slug, env);
  if (error) return error;

  const updated = { ...withRoadmap(record, roadmap), _patchedAt: new Date().toISOString() };
  try {
    await env.MASTERHUB_STUDENTS.put(`eleve:${slug}`, JSON.stringify(updated));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }
  return jsonResponse({ ok: true, roadmap, data: updated });
}
