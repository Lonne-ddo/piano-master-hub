const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
}

// ── Vérification auth ────────────────────────────────────────
function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || ''
  const token = auth.replace('Bearer ', '').trim()
  return token === env.ADMIN_SECRET
}

// ── GET /api/history ─ Lister les 20 dernières entrées ───────
async function handleGet(env) {
  const list = await env.MASTERHUB_HISTORY.list({ prefix: 'history:', limit: 20 })

  // Trier par clé décroissante (timestamp dans la clé)
  const keys = list.keys.sort((a, b) => b.name.localeCompare(a.name))

  const items = await Promise.all(
    keys.map(async k => {
      const raw = await env.MASTERHUB_HISTORY.get(k.name)
      try {
        return { key: k.name, data: JSON.parse(raw) }
      } catch {
        return { key: k.name, data: {} }
      }
    })
  )

  return Response.json(items, { headers: CORS_HEADERS })
}

// ── POST /api/history ─ Sauvegarder une entrée ───────────────
async function handlePost(request, env) {
  const body = await request.json()
  const { key, data } = body

  if (!key || !data) {
    return Response.json({ error: 'key et data requis' }, { status: 400, headers: CORS_HEADERS })
  }

  await env.MASTERHUB_HISTORY.put(key, JSON.stringify(data))
  return Response.json({ success: true }, { headers: CORS_HEADERS })
}

// ── DELETE /api/history?key= ─ Supprimer une entrée ──────────
async function handleDelete(request, env) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')

  if (!key) {
    return Response.json({ error: 'Paramètre key requis' }, { status: 400, headers: CORS_HEADERS })
  }

  await env.MASTERHUB_HISTORY.delete(key)
  return Response.json({ success: true }, { headers: CORS_HEADERS })
}

// ── Dispatcher principal ──────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // Vérifier auth
  if (!checkAuth(request, env)) {
    return Response.json({ error: 'Non autorisé' }, { status: 401, headers: CORS_HEADERS })
  }

  const method = request.method.toUpperCase()

  if (method === 'GET')    return handleGet(env)
  if (method === 'POST')   return handlePost(request, env)
  if (method === 'DELETE') return handleDelete(request, env)

  return Response.json({ error: 'Méthode non supportée' }, { status: 405, headers: CORS_HEADERS })
}
