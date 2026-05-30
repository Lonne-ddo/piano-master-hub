// ─── PATCH / DELETE /api/admin/eleves/:slug/repertoire/:id ───────
// Édition / suppression d'un morceau (admin only, cookie mh_admin_pw).
// PATCH body : champs partiels { titre?, tonalite?, date_debut?, statut?,
//   notes?, resources? } — seuls les champs présents sont mis à jour.
// Réponse PATCH  : { ok, morceau } | 400 | 404.
// Réponse DELETE : { ok, id } | 404.

import { corsAdmin } from '../../../../_lib/cors.js';
import { requireAdminPassword } from '../../../../_lib/session.js';
import {
  isValidSlug,
  readRepertoire,
  writeRepertoire,
  buildMorceau,
} from '../../../../_lib/repertoire.js';

const METHODS = 'PATCH, DELETE, OPTIONS';

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsAdmin(request, { methods: METHODS }),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsAdmin(request, { methods: METHODS }) });
}

export async function onRequestPatch({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse(request, { error: 'unauthorized' }, 401);
  }
  const slug = String(params?.slug || '').toLowerCase();
  const id = String(params?.id || '');
  if (!(await isValidSlug(slug, env))) return jsonResponse(request, { error: 'invalid_slug' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, { error: 'invalid_json' }, 400); }

  const morceaux = await readRepertoire(env, slug);
  const idx = morceaux.findIndex((m) => m && m.id === id);
  if (idx === -1) return jsonResponse(request, { error: 'not_found' }, 404);

  const built = buildMorceau(body, { mode: 'patch', existing: morceaux[idx] });
  if (built.error) return jsonResponse(request, { error: built.error }, 400);

  morceaux[idx] = built.value;
  try {
    await writeRepertoire(env, slug, morceaux);
  } catch (e) {
    return jsonResponse(request, { error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse(request, { ok: true, morceau: built.value });
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse(request, { error: 'unauthorized' }, 401);
  }
  const slug = String(params?.slug || '').toLowerCase();
  const id = String(params?.id || '');
  if (!(await isValidSlug(slug, env))) return jsonResponse(request, { error: 'invalid_slug' }, 400);

  const morceaux = await readRepertoire(env, slug);
  const next = morceaux.filter((m) => !(m && m.id === id));
  if (next.length === morceaux.length) return jsonResponse(request, { error: 'not_found' }, 404);

  try {
    await writeRepertoire(env, slug, next);
  } catch (e) {
    return jsonResponse(request, { error: 'kv_delete_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse(request, { ok: true, id });
}
