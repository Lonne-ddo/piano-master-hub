// Endpoint /api/history — historique transcripteur (KV MASTERHUB_HISTORY).
// Auth : admin via cookie mh_admin_pw (HMAC).

import { requireAdminPassword } from './_lib/session.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Limites de validation (anti-DOS / anti-pollution KV)
// Seules les clés history:* sont acceptées (protège __folders__, __recent__…).
const KEY_RE = /^history:[a-zA-Z0-9_\-.]{1,92}$/
// CF KV value limit = 25 MiB. 1 MB par record = headroom large pour les
// transcriptions multi-parts longues (1h30+ avec transcript brut + sections).
const MAX_VALUE_BYTES = 1 * 1024 * 1024 // 1 MB

// Registre des dossiers de classement : un seul record KV sous une clé
// réservée (hors préfixe "history:", donc jamais listé comme entrée).
// Format : [{ id, name, type }] où type = "seance" | "formation".
const FOLDERS_KEY = '__folders__'
const MAX_FOLDERS = 200
const FOLDER_NAME_MAX = 60

// Index des clés récentes (hors préfixe "history:"), mis à jour au POST et
// au DELETE. KV.list() est éventuellement cohérent (~60 s) : l'index garantit
// qu'une entrée tout juste créée apparaît immédiatement dans le GET.
const RECENT_KEY = '__recent__'
const RECENT_MAX = 50

async function readRecent(env) {
  const raw = await env.MASTERHUB_HISTORY.get(RECENT_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(k => typeof k === 'string' && KEY_RE.test(k)) : []
  } catch {
    return []
  }
}

async function updateRecent(env, fn) {
  try {
    const next = fn(await readRecent(env))
    await env.MASTERHUB_HISTORY.put(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)))
  } catch (e) {
    console.warn('[history] recent index update failed:', e?.message || e)
  }
}

// ── GET /api/history ─ Lister les 50 entrées les plus récentes ──
// list() renvoie les clés en ordre lexicographique CROISSANT (les plus
// anciennes d'abord) : on pagine tout l'index, puis on trie en décroissant.
async function handleGet(env) {
  const names = new Set(await readRecent(env))
  let cursor
  do {
    const page = await env.MASTERHUB_HISTORY.list({ prefix: 'history:', cursor })
    for (const k of page.keys) names.add(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  // Trier par clé décroissante (timestamp dans la clé)
  const keys = [...names].sort((a, b) => b.localeCompare(a)).slice(0, RECENT_MAX)

  const items = (await Promise.all(
    keys.map(async name => {
      const raw = await env.MASTERHUB_HISTORY.get(name)
      if (raw === null) return null // supprimée mais encore dans list()/index
      try {
        return { key: name, data: JSON.parse(raw) }
      } catch {
        return { key: name, data: {} }
      }
    })
  )).filter(Boolean)

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
    return Response.json({ error: 'invalid_key', detail: 'must match /^history:[a-zA-Z0-9_-.]{1,92}$/' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return Response.json({ error: 'invalid_data', detail: 'must be a plain object' }, { status: 400, headers: CORS_HEADERS })
  }

  // Type de transcription (rétro-compat : tout ce qui n'est pas "formation"
  // — y compris absent ou anciennes entrées — vaut "seance").
  data.type = data.type === 'formation' ? 'formation' : 'seance'

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
  await updateRecent(env, keys => [key, ...keys.filter(k => k !== key)].sort((a, b) => b.localeCompare(a)))
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
  await updateRecent(env, keys => keys.filter(k => k !== key))
  return Response.json({ success: true }, { headers: CORS_HEADERS })
}

// ── Dossiers ─ registre unique sous FOLDERS_KEY ──────────────
// Sous-ressource de /api/history via ?resource=folders (pas de nouvel
// endpoint). Le déplacement d'une entrée se fait via le PATCH d'entrée
// générique ({ key, data:{ folderId } }) : rien de spécifique ici.
async function readFolders(env) {
  const raw = await env.MASTERHUB_HISTORY.get(FOLDERS_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// GET ?resource=folders ─ Lister tous les dossiers (tous modes)
async function handleFoldersGet(env) {
  return Response.json(await readFolders(env), { headers: CORS_HEADERS })
}

// POST ?resource=folders ─ Créer un dossier { name, type }
async function handleFoldersPost(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: CORS_HEADERS })
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const type = body?.type === 'formation' ? 'formation' : 'seance'
  if (!name) {
    return Response.json({ error: 'invalid_data', detail: 'name required' }, { status: 400, headers: CORS_HEADERS })
  }
  if (name.length > FOLDER_NAME_MAX) {
    return Response.json({ error: 'invalid_data', detail: `name max ${FOLDER_NAME_MAX} chars` }, { status: 400, headers: CORS_HEADERS })
  }

  const folders = await readFolders(env)
  if (folders.length >= MAX_FOLDERS) {
    return Response.json({ error: 'too_many_folders', detail: `max ${MAX_FOLDERS}` }, { status: 400, headers: CORS_HEADERS })
  }

  const folder = { id: crypto.randomUUID(), name, type }
  folders.push(folder)
  try {
    await env.MASTERHUB_HISTORY.put(FOLDERS_KEY, JSON.stringify(folders))
  } catch (e) {
    console.error('[history] folders POST put failed:', e?.message || e)
    return Response.json({ error: 'kv_put_failed' }, { status: 500, headers: CORS_HEADERS })
  }
  return Response.json(folder, { headers: CORS_HEADERS })
}

// PATCH ?resource=folders ─ Renommer un dossier { id, name }
// N'affecte QUE le registre : les entrées (folderId) restent inchangées.
async function handleFoldersPatch(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: CORS_HEADERS })
  }
  const id   = typeof body?.id === 'string' ? body.id : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!id || !name) {
    return Response.json({ error: 'invalid_data', detail: 'id and name required' }, { status: 400, headers: CORS_HEADERS })
  }
  if (name.length > FOLDER_NAME_MAX) {
    return Response.json({ error: 'invalid_data', detail: `name max ${FOLDER_NAME_MAX} chars` }, { status: 400, headers: CORS_HEADERS })
  }

  const folders = await readFolders(env)
  const folder = folders.find(f => f.id === id)
  if (!folder) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: CORS_HEADERS })
  }

  folder.name = name
  try {
    await env.MASTERHUB_HISTORY.put(FOLDERS_KEY, JSON.stringify(folders))
  } catch (e) {
    console.error('[history] folders PATCH put failed:', e?.message || e)
    return Response.json({ error: 'kv_put_failed' }, { status: 500, headers: CORS_HEADERS })
  }
  return Response.json(folder, { headers: CORS_HEADERS })
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

  // Sous-ressource dossiers : /api/history?resource=folders
  const resource = new URL(request.url).searchParams.get('resource')
  if (resource === 'folders') {
    if (method === 'GET')   return handleFoldersGet(env)
    if (method === 'POST')  return handleFoldersPost(request, env)
    if (method === 'PATCH') return handleFoldersPatch(request, env)
    return Response.json({ error: 'Méthode non supportée' }, { status: 405, headers: CORS_HEADERS })
  }

  if (method === 'GET')    return handleGet(env)
  if (method === 'POST')   return handlePost(request, env)
  if (method === 'PATCH')  return handlePatch(request, env)
  if (method === 'DELETE') return handleDelete(request, env)

  return Response.json({ error: 'Méthode non supportée' }, { status: 405, headers: CORS_HEADERS })
}
