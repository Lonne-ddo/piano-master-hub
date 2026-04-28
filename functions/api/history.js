// Endpoint /api/history — historique transcripteur (KV MASTERHUB_HISTORY).
// Auth : x-admin-secret (uniformisé avec les autres endpoints admin).
// Backwards-compat : Authorization: Bearer <secret> est aussi accepté tant que
// admin/transcripteur.html n'est pas migré.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
}

// Limites de validation (anti-DOS / anti-pollution KV)
const KEY_RE = /^[a-zA-Z0-9:_\-.]{1,100}$/
const MAX_VALUE_BYTES = 50 * 1024 // 50 KB par entrée (largement assez pour métadonnées + transcript court)

// ── Vérification auth (x-admin-secret prioritaire ; Bearer en fallback legacy)
function checkAuth(request, env) {
  const adminSecret = request.headers.get('x-admin-secret')
  if (adminSecret && adminSecret === env.ADMIN_SECRET) return true
  const auth = request.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) return false
  const token = auth.slice('Bearer '.length).trim()
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
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: CORS_HEADERS })
  }

  const { key, data } = body || {}
  if (!key || typeof key !== 'string' || !KEY_RE.test(key)) {
    return Response.json({ error: 'invalid_key', detail: 'must match /^[a-zA-Z0-9:_-.]{1,100}$/' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return Response.json({ error: 'invalid_data', detail: 'must be a plain object' }, { status: 400, headers: CORS_HEADERS })
  }

  let serialized
  try {
    serialized = JSON.stringify(data)
  } catch {
    return Response.json({ error: 'invalid_data', detail: 'cannot stringify' }, { status: 400, headers: CORS_HEADERS })
  }
  if (serialized.length > MAX_VALUE_BYTES) {
    return Response.json({ error: 'payload_too_large', detail: `max ${MAX_VALUE_BYTES} bytes` }, { status: 413, headers: CORS_HEADERS })
  }

  try {
    await env.MASTERHUB_HISTORY.put(key, serialized)
  } catch (e) {
    console.error('[history] KV put failed:', e?.message || e, 'key:', key)
    return Response.json({ error: 'kv_put_failed' }, { status: 500, headers: CORS_HEADERS })
  }
  return Response.json({ success: true }, { headers: CORS_HEADERS })
}

// ── DELETE /api/history?key= ─ Supprimer une entrée ──────────
async function handleDelete(request, env) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')

  if (!key || !KEY_RE.test(key)) {
    return Response.json({ error: 'invalid_key' }, { status: 400, headers: CORS_HEADERS })
  }

  try {
    await env.MASTERHUB_HISTORY.delete(key)
  } catch (e) {
    console.error('[history] KV delete failed:', e?.message || e, 'key:', key)
    return Response.json({ error: 'kv_delete_failed' }, { status: 500, headers: CORS_HEADERS })
  }
  return Response.json({ success: true }, { headers: CORS_HEADERS })
}

// ── Dispatcher principal ──────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (!checkAuth(request, env)) {
    return Response.json({ error: 'Non autorisé' }, { status: 401, headers: CORS_HEADERS })
  }

  const method = request.method.toUpperCase()

  if (method === 'GET')    return handleGet(env)
  if (method === 'POST')   return handlePost(request, env)
  if (method === 'DELETE') return handleDelete(request, env)

  return Response.json({ error: 'Méthode non supportée' }, { status: 405, headers: CORS_HEADERS })
}
