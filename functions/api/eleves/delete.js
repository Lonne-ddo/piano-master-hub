// ─── DELETE /api/eleves/delete?slug=xxx ──────────────────────────
// Supprime UNIQUEMENT l'entrée `student:<slug>`.
// Les sessions historiques de cet élève dans MASTERHUB_QUIZ_HISTORY
// (clés `quiz:<slug>:<ts>`) restent intactes pour conserver l'historique.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

const SLUG_RE = /^[a-z0-9_-]{2,30}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestDelete({ request, env }) {
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_STUDENTS) {
    return json({ error: 'kv_not_bound' }, 500);
  }

  const url = new URL(request.url);
  const slug = String(url.searchParams.get('slug') || '').trim().toLowerCase();

  if (!SLUG_RE.test(slug)) {
    return json({ error: 'invalid_slug' }, 400);
  }

  // Vérifie l'existence (pour rapport propre, pas obligatoire)
  let existed = false;
  try {
    const raw = await env.MASTERHUB_STUDENTS.get('student:' + slug);
    existed = raw != null;
  } catch (e) {
    // get échoue : on tente quand même le delete
  }

  try {
    await env.MASTERHUB_STUDENTS.delete('student:' + slug);
  } catch (e) {
    return json({ error: 'kv_delete_failed', details: e?.message || '' }, 500);
  }

  return json({
    ok: true,
    deleted: slug,
    existed,
    note: 'Sessions quiz historiques (MASTERHUB_QUIZ_HISTORY) non supprimées'
  });
}
