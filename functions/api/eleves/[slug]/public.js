// ─── GET /api/eleves/{slug}/public ──────────────────────────────
// Endpoint protégé par cookie de session `mh_session` (Chantier C — magic link).
// L'élève doit être authentifié ET la session doit correspondre au slug demandé.
// Whitelist STRICTE des champs exposés. PAS d'observations (privé coach).

import { requireEleveOrAdmin } from '../../_lib/session.js';
import { loadEleveStats } from '../../_lib/eleves-stats.js';
import { checkSlug, ELEVES_UNAVAILABLE } from '../../_lib/eleves-list.js';

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
  const known = await checkSlug(env, slug);
  if (known === null) return jsonResponse(ELEVES_UNAVAILABLE, 503);
  if (!known) {
    return jsonResponse({ error: 'invalid_slug' }, 400);
  }

  // ── Auth : admin (cookie mh_admin_pw) → consulte n'importe quel slug.
  //   Élève (cookie mh_session) → consulte uniquement sa propre fiche.
  const auth = await requireEleveOrAdmin(slug, request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let data = null;
  try {
    data = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ error: 'kv_error', details: e?.message || '' }, 500);
  }

  if (!data) {
    return jsonResponse({
      slug, stats: null, derniere_seance: null, doc_url: null,
      links: { drive: null, telegram: null },
    });
  }

  // Stats recalculées à chaque lecture (séances publiées + accompagnement).
  // Whitelist STRICTE des champs exposés (sécurité côté élève)
  const live = await loadEleveStats(env, slug, data);
  const stats = {
    accompagnement: live.accompagnement,
    nb_seances: live.nb_seances,
    nb_cours: live.nb_cours,
    date_debut: live.date_debut,
    date_debut_label: live.date_debut_label,
    date_fin: live.date_fin,
    date_fin_label: live.date_fin_label,
    progression_pct: live.progression_pct,
  };

  const derniere_seance = data.derniere_seance ? {
    date: data.derniere_seance.date ?? null,
    titre: data.derniere_seance.titre ?? null,
    devoirs: Array.isArray(data.derniere_seance.devoirs)
      ? data.derniere_seance.devoirs.filter(Boolean).map(String)
      : null,
    resume: Array.isArray(data.derniere_seance.resume)
      ? data.derniere_seance.resume.filter(Boolean).map(String)
      : null,
    // Séance éditée par le coach (formulaire admin) : ses devoirs priment
    // sur ceux parsés depuis le Doc côté client.
    manualEdit: data.derniere_seance.manualEdit === true,
    // PAS d'observations (privé coach)
  } : null;

  const doc_url = data.doc_url
    || (data.doc_id ? `https://docs.google.com/document/d/${data.doc_id}/edit` : null);

  // Liens canaux personnels exposés à l'élève (whitelist stricte des URLs).
  // Pas de handle ni autre meta privée. Validation https:// pour éviter
  // les javascript: et data: URI dans le HTML rendu côté client.
  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    return /^https?:\/\//i.test(u) ? u : null;
  }
  const links = {
    drive: safeUrl(data.canaux?.drive?.url),
    telegram: safeUrl(data.canaux?.telegram?.url),
  };

  return jsonResponse({ slug, stats, derniere_seance, doc_url, links });
}
