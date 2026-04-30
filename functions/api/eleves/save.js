// ─── POST /api/eleves/save ───────────────────────────────────────
// Crée ou met à jour un élève (clé `student:<slug>`).
//
// Body : { slug, nom, email?, date_debut?, date_fin?, statut }
//
// Validations :
//   - slug : /^[a-z0-9_-]+$/, 2-30 chars (immuable une fois créé)
//   - nom  : non vide, 2-50 chars
//   - email : optionnel, regex basique si présent
//   - date_debut/date_fin : YYYY-MM-DD si présent (pas de validation calendaire stricte)
//   - statut : 'actif' ou 'archive'
//
// Comportement : upsert (écrase si slug existant). Pas de notion de création vs
// update côté API : c'est un PUT logique sur la clé.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

const SLUG_RE  = /^[a-z0-9_-]{2,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const STATUTS  = ['actif', 'archive'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_STUDENTS) {
    return json({ error: 'kv_not_bound' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const slug = String(body.slug || '').trim().toLowerCase();
  const nom  = String(body.nom  || '').trim();
  const email = String(body.email || '').trim();
  const dateDebut = String(body.date_debut || '').trim();
  const dateFin   = String(body.date_fin   || '').trim();
  const statut    = String(body.statut || '').trim();

  if (!SLUG_RE.test(slug)) {
    return json({ error: 'invalid_slug', detail: 'lowercase alphanumeric/_/- entre 2 et 30 caractères' }, 400);
  }
  if (!nom || nom.length < 2 || nom.length > 50) {
    return json({ error: 'invalid_nom', detail: 'requis, 2 à 50 caractères' }, 400);
  }
  if (email && !EMAIL_RE.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }
  if (dateDebut && !DATE_RE.test(dateDebut)) {
    return json({ error: 'invalid_date_debut', detail: 'format YYYY-MM-DD attendu' }, 400);
  }
  if (dateFin && !DATE_RE.test(dateFin)) {
    return json({ error: 'invalid_date_fin', detail: 'format YYYY-MM-DD attendu' }, 400);
  }
  if (STATUTS.indexOf(statut) < 0) {
    return json({ error: 'invalid_statut', detail: "valeurs autorisées : 'actif' ou 'archive'" }, 400);
  }

  const eleve = { slug, nom, email, date_debut: dateDebut, date_fin: dateFin, statut };

  try {
    await env.MASTERHUB_STUDENTS.put('student:' + slug, JSON.stringify(eleve));
  } catch (e) {
    return json({ error: 'kv_put_failed', details: e?.message || '' }, 500);
  }

  return json({ ok: true, eleve });
}
