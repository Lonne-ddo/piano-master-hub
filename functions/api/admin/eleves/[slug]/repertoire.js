// ─── POST /api/admin/eleves/:slug/repertoire ─────────────────────
// Création d'un morceau (admin only, cookie mh_admin_pw).
// Body : { titre, tonalite?, date_debut, statut?, notes?, resources? }
// Réponse : 201 { ok, morceau } | 400 validation | 401 unauthorized.

import { corsAdmin } from '../../../_lib/cors.js';
import { requireAdminPassword } from '../../../_lib/session.js';
import {
  isValidSlug,
  readRepertoire,
  writeRepertoire,
  buildMorceau,
} from '../../../_lib/repertoire.js';

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsAdmin(request, { methods: 'POST, OPTIONS' }),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsAdmin(request, { methods: 'POST, OPTIONS' }) });
}

export async function onRequestPost({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse(request, { error: 'unauthorized' }, 401);
  }
  const slug = String(params?.slug || '').toLowerCase();
  if (!(await isValidSlug(slug, env))) return jsonResponse(request, { error: 'invalid_slug' }, 400);
  if (!env.MASTERHUB_HISTORY) return jsonResponse(request, { error: 'kv_not_bound' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, { error: 'invalid_json' }, 400); }

  const built = buildMorceau(body, { mode: 'create' });
  if (built.error) return jsonResponse(request, { error: built.error }, 400);

  const morceaux = await readRepertoire(env, slug);
  morceaux.push(built.value);
  try {
    await writeRepertoire(env, slug, morceaux);
  } catch (e) {
    return jsonResponse(request, { error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse(request, { ok: true, morceau: built.value }, 201);
}
