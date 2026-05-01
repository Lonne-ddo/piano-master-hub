// ─── GET /api/eleves/{slug}/public ──────────────────────────────
// Endpoint protégé par cookie de session `mh_session` (Chantier C — magic link).
// L'élève doit être authentifié ET la session doit correspondre au slug demandé.
// Whitelist STRICTE des champs exposés. PAS d'observations (privé coach).

import { getSessionFromRequest } from '../../_lib/session.js';

// Source primaire : KV `eleves:list`. FALLBACK_SLUGS pour dégradation gracieuse.
const FALLBACK_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

async function isValidSlug(slug, env) {
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const valid = Array.isArray(list) && list.length ? list : FALLBACK_SLUGS;
    return valid.includes(slug);
  } catch {
    return FALLBACK_SLUGS.includes(slug);
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ params, request, env }) {
  const slug = String(params.slug || '').toLowerCase();
  if (!await isValidSlug(slug, env)) {
    return jsonResponse({ error: 'invalid_slug' }, 400);
  }

  // ── Auth : cookie session valide + slug match ──
  const session = await getSessionFromRequest(request, env);
  if (!session || session.slug !== slug) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let data = null;
  try {
    data = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_error', details: e?.message || '' }, 500);
  }

  if (!data) {
    return jsonResponse({ slug, stats: null, derniere_seance: null, doc_url: null });
  }

  // Whitelist STRICTE des champs exposés (sécurité côté élève)
  const stats = data.stats ? {
    nb_cours: data.stats.nb_cours ?? null,
    date_debut: data.stats.date_debut ?? null,
    date_debut_label: data.stats.date_debut_label ?? null,
    date_fin: data.stats.date_fin ?? null,
    date_fin_label: data.stats.date_fin_label ?? null,
    progression_pct: data.stats.progression_pct ?? null,
  } : null;

  const derniere_seance = data.derniere_seance ? {
    date: data.derniere_seance.date ?? null,
    titre: data.derniere_seance.titre ?? null,
    devoirs: Array.isArray(data.derniere_seance.devoirs)
      ? data.derniere_seance.devoirs.filter(Boolean).map(String)
      : null,
    resume: Array.isArray(data.derniere_seance.resume)
      ? data.derniere_seance.resume.filter(Boolean).map(String)
      : null,
    // PAS d'observations (privé coach)
  } : null;

  const doc_url = data.doc_url
    || (data.doc_id ? `https://docs.google.com/document/d/${data.doc_id}/edit` : null);

  return jsonResponse({ slug, stats, derniere_seance, doc_url });
}
