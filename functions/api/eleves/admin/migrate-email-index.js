// ─── /api/eleves/admin/migrate-email-index ─────────────────────
// One-shot admin endpoint pour synchroniser l'index inverse `email:<email>`
// avec les `eleve:<slug>.email` déjà peuplés.
//
// Auth : super-admin via session cookie (is_admin === true) + isAdminEmail.
//
// GET  → audit : pour chaque slug, retourne l'état actuel
//   {
//     ok: true,
//     items: [{
//       slug, email, index_present, index_slug, action: 'noop'|'create'|'fix'|'orphan'
//     }],
//     summary: { create: N, fix: N, orphan: N, noop: N }
//   }
//
// POST → migration : applique les actions (création des index manquants,
// correction des index pointant vers le mauvais slug). Aucune suppression
// d'index "orphelin" automatique (un index pointant vers un slug sans email
// est laissé tel quel — il faut le supprimer manuellement via wrangler).

import { getSessionFromRequest, isAdminEmail } from '../../_lib/session.js';

const FALLBACK_SLUGS = ['japhet', 'messon', 'dexter', 'tara'];

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

async function requireAdmin(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (!session?.is_admin) return null;
  if (!isAdminEmail(session.email, env)) return null;
  return session;
}

async function listSlugs(env) {
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fallback */ }
  return FALLBACK_SLUGS;
}

// Calcule l'action requise pour aligner l'index inverse sur eleve:<slug>.email
async function planForSlug(env, slug) {
  let eleveData;
  try { eleveData = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' }); }
  catch { eleveData = null; }

  const email = (eleveData && typeof eleveData.email === 'string')
    ? eleveData.email.trim().toLowerCase()
    : null;

  if (!email) {
    return { slug, email: null, index_present: false, index_slug: null, action: 'noop' };
  }

  let indexEntry;
  try { indexEntry = await env.MASTERHUB_STUDENTS.get(`email:${email}`, { type: 'json' }); }
  catch { indexEntry = null; }

  if (!indexEntry || typeof indexEntry.slug !== 'string') {
    return { slug, email, index_present: false, index_slug: null, action: 'create' };
  }
  if (indexEntry.slug !== slug) {
    return { slug, email, index_present: true, index_slug: indexEntry.slug, action: 'fix' };
  }
  return { slug, email, index_present: true, index_slug: indexEntry.slug, action: 'noop' };
}

function summarize(items) {
  const summary = { noop: 0, create: 0, fix: 0, orphan: 0 };
  for (const it of items) {
    if (summary[it.action] !== undefined) summary[it.action]++;
  }
  return summary;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_STUDENTS) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const slugs = await listSlugs(env);
  const items = await Promise.all(slugs.map((s) => planForSlug(env, s)));

  return jsonResponse({ ok: true, mode: 'audit', items, summary: summarize(items) });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdmin(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.MASTERHUB_STUDENTS) return jsonResponse({ error: 'kv_not_bound' }, 500);

  const slugs = await listSlugs(env);
  const items = await Promise.all(slugs.map((s) => planForSlug(env, s)));

  const applied = [];
  for (const it of items) {
    if (it.action === 'create' || it.action === 'fix') {
      try {
        await env.MASTERHUB_STUDENTS.put(`email:${it.email}`, JSON.stringify({ slug: it.slug }));
        applied.push({ slug: it.slug, email: it.email, action: it.action, ok: true });
      } catch (e) {
        applied.push({ slug: it.slug, email: it.email, action: it.action, ok: false, error: e?.message || '' });
      }
    }
  }

  return jsonResponse({
    ok: true,
    mode: 'migrate',
    items,
    summary: summarize(items),
    applied,
  });
}
