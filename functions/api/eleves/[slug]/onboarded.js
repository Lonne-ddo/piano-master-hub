// ─── /api/eleves/:slug/onboarded ─────────────────────────────────
// Suivi du premier accès d'un élève à son espace (pour l'animation
// d'onboarding qui ne se joue qu'une fois).
//
// Stockage : MASTERHUB_HISTORY, clé `onboarded:<slug>`, valeur
//   { firstSeenAt: number_ms }.
//
// GET  : lecture publique → { seen: boolean, firstSeenAt: number|null }
// POST : écriture idempotente publique → { seen: true, firstSeenAt }
//        (si déjà vu, renvoie le record existant sans le modifier).
//
// Slug invalide → 404 (le front skippe l'animation dans ce cas).

import { CORS_PUBLIC } from '../../_lib/cors.js';
import { requireAdminPassword } from '../../_lib/session.js';

const FALLBACK_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_PUBLIC, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function isValidSlug(slug, env) {
  if (!slug) return false;
  if (!env.MASTERHUB_STUDENTS) return FALLBACK_SLUGS.includes(slug);
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const valid = (Array.isArray(list) && list.length)
      ? list.map((s) => String(s).toLowerCase())
      : FALLBACK_SLUGS;
    return valid.includes(slug);
  } catch {
    return FALLBACK_SLUGS.includes(slug);
  }
}

async function readRecord(env, slug) {
  if (!env.MASTERHUB_HISTORY) return null;
  try {
    return await env.MASTERHUB_HISTORY.get(`onboarded:${slug}`, { type: 'json' });
  } catch {
    return null;
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_PUBLIC });
}

// ─── GET (public) ────────────────────────────────────────────────
export async function onRequestGet({ params, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'not_found' }, 404);

  const rec = await readRecord(env, slug);
  const firstSeenAt = (rec && typeof rec.firstSeenAt === 'number') ? rec.firstSeenAt : null;
  return jsonResponse({ seen: firstSeenAt !== null, firstSeenAt });
}

// ─── POST (public, idempotent) ───────────────────────────────────
export async function onRequestPost({ params, env }) {
  const slug = String(params?.slug || '').toLowerCase();
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'not_found' }, 404);
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  // Idempotent : si un firstSeenAt existe déjà, on ne l'écrase jamais.
  const existing = await readRecord(env, slug);
  if (existing && typeof existing.firstSeenAt === 'number') {
    return jsonResponse({ seen: true, firstSeenAt: existing.firstSeenAt });
  }

  const firstSeenAt = Date.now();
  try {
    await env.MASTERHUB_HISTORY.put(`onboarded:${slug}`, JSON.stringify({ firstSeenAt }));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }
  return jsonResponse({ seen: true, firstSeenAt });
}

// ─── DELETE (admin only) — reset onboarding pour re-tester l'anim ─
// Supprime le record `onboarded:<slug>` → l'élève reverra l'animation
// à son prochain accès. Réservé à l'admin (cookie mh_admin_pw).
export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const slug = String(params?.slug || '').toLowerCase();
  if (!(await isValidSlug(slug, env))) return jsonResponse({ error: 'not_found' }, 404);
  if (!env.MASTERHUB_HISTORY) return jsonResponse({ error: 'kv_not_bound' }, 500);

  try {
    await env.MASTERHUB_HISTORY.delete(`onboarded:${slug}`);
  } catch (e) {
    return jsonResponse({ error: 'kv_delete_failed', detail: e?.message || '' }, 500);
  }
  return jsonResponse({ ok: true, seen: false, firstSeenAt: null });
}
