// Endpoint /api/history — historique transcripteur (KV MASTERHUB_HISTORY).
// Auth : admin via cookie mh_admin_pw (HMAC).

import { requireAdminPassword } from './_lib/session.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Limites de validation (anti-DOS / anti-pollution KV)
const KEY_RE = /^[a-zA-Z0-9:_\-.]{1,100}$/
// CF KV value limit = 25 MiB. 1 MB par record = headroom large pour les
// transcriptions multi-parts longues (1h30+ avec transcript brut + sections).
const MAX_VALUE_BYTES = 1 * 1024 * 1024 // 1 MB

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

// ── PATCH /api/history ─ Update partiel d'une entrée existante ───
// Body : { key, data: {...partialFields} }
// Read-modify-write côté serveur : on lit le record actuel, on merge les
// champs reçus par-dessus, on ré-écrit. Évite de retransférer le record
// complet (transcript brut + meta) à chaque édit titre/section.
async function handlePatch(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: CORS_HEADERS })
  }

  const { key, data: partial } = body || {}
  if (!key || typeof key !== 'string' || !KEY_RE.test(key)) {
    return Response.json({ error: 'invalid_key' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return Response.json({ error: 'invalid_data', detail: 'must be a partial object' }, { status: 400, headers: CORS_HEADERS })
  }

  let existingRaw
  try {
    existingRaw = await env.MASTERHUB_HISTORY.get(key)
  } catch (e) {
    return Response.json({ error: 'kv_get_failed', detail: e?.message || '' }, { status: 500, headers: CORS_HEADERS })
  }
  if (!existingRaw) {
    return Response.json({ error: 'not_found', detail: 'no record for that key, use POST to create' }, { status: 404, headers: CORS_HEADERS })
  }

  let existing
  try {
    existing = JSON.parse(existingRaw)
  } catch {
    return Response.json({ error: 'corrupted_record' }, { status: 500, headers: CORS_HEADERS })
  }

  const merged = { ...existing, ...partial }
  let serialized
  try {
    serialized = JSON.stringify(merged)
  } catch {
    return Response.json({ error: 'invalid_data', detail: 'cannot stringify' }, { status: 400, headers: CORS_HEADERS })
  }
  if (serialized.length > MAX_VALUE_BYTES) {
    return Response.json({ error: 'payload_too_large', detail: `max ${MAX_VALUE_BYTES} bytes after merge` }, { status: 413, headers: CORS_HEADERS })
  }

  try {
    await env.MASTERHUB_HISTORY.put(key, serialized)
  } catch (e) {
    console.error('[history] PATCH KV put failed:', e?.message || e, 'key:', key)
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

  if (!(await requireAdminPassword(request, env))) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS_HEADERS })
  }

  const method = request.method.toUpperCase()

  if (method === 'GET')    return handleGet(env)
  if (method === 'POST')   return handlePost(request, env)
  if (method === 'PATCH')  return handlePatch(request, env)
  if (method === 'DELETE') return handleDelete(request, env)

  return Response.json({ error: 'Méthode non supportée' }, { status: 405, headers: CORS_HEADERS })
}
