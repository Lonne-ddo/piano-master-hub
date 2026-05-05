// ─── /api/eleves ─────────────────────────────────────────────────
// GET  : liste des slugs (public, source de vérité KV `eleves:list`)
// POST : création d'un élève (admin only) — slugify nom + unicité.
//
// Réponses :
//   GET  → { ok: true, eleves: ['japhet','messon',...], source: 'kv'|'seeded'|'fallback' }
//   POST → 201 { ok: true, slug, ...eleve } | 400 invalid_input | 409 already_exists | 401 unauthorized

import { requireAdminPassword } from '../_lib/session.js';

const DEFAULT_ELEVES = ['japhet', 'messon', 'dexter', 'tara'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}

// ─── Slugify accents-aware ────────────────────────────────────────
// "Lucas-Émilien"  → "lucas-emilien"
// "François Müller" → "francois-muller"
// "  Léa O'Connor  " → "lea-o-connor"
function slugify(str) {
  if (typeof str !== 'string') return '';
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/i;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── GET (public) ────────────────────────────────────────────────
export async function onRequestGet({ env }) {
  try {
    const raw = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (Array.isArray(raw) && raw.length > 0) {
      const cleaned = raw.map(s => String(s).toLowerCase()).filter(Boolean);
      return jsonResponse({ ok: true, eleves: cleaned, source: 'kv' });
    }
    // Bootstrap : seed la clé eleves:list avec la liste par défaut (idempotent)
    await env.MASTERHUB_STUDENTS.put('eleves:list', JSON.stringify(DEFAULT_ELEVES));
    return jsonResponse({ ok: true, eleves: DEFAULT_ELEVES, source: 'seeded' });
  } catch (e) {
    // KV down ou erreur de parse : fallback gracieux sans persistance
    return jsonResponse({ ok: true, eleves: DEFAULT_ELEVES, source: 'fallback', error: e?.message || '' });
  }
}

// ─── POST (admin only) — création élève ─────────────────────────
// Body : { nom, email, doc_url?, canaux? }
//   - nom : requis, 1-80 chars (slugify)
//   - email : requis, format valide, unique
//   - doc_url : optionnel, URL https://docs.google.com/...
//   - canaux : optionnel, { telegram?, discord?, bonzai?, drive? } avec url valide
export async function onRequestPost({ request, env }) {
  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_STUDENTS) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  // Validation nom
  const nomRaw = typeof body?.nom === 'string' ? body.nom.trim() : '';
  if (!nomRaw || nomRaw.length > 80) {
    return jsonResponse({ error: 'invalid_nom', detail: 'nom requis, max 80 chars' }, 400);
  }
  const slug = slugify(nomRaw);
  if (!slug || slug.length < 2 || slug.length > 40) {
    return jsonResponse({ error: 'invalid_slug', detail: 'le nom doit contenir au moins 2 caractères alphanumériques' }, 400);
  }

  // Validation email
  const emailRaw = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return jsonResponse({ error: 'invalid_email' }, 400);
  }

  // Unicité slug
  let existingEleve;
  try { existingEleve = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`); }
  catch { existingEleve = null; }
  if (existingEleve) {
    return jsonResponse({ error: 'slug_already_exists', slug }, 409);
  }

  // Unicité email (via index inverse)
  let existingEmailIdx;
  try { existingEmailIdx = await env.MASTERHUB_STUDENTS.get(`email:${emailRaw}`); }
  catch { existingEmailIdx = null; }
  if (existingEmailIdx) {
    return jsonResponse({ error: 'email_already_exists', email: emailRaw }, 409);
  }

  // Validation doc_url (optionnel)
  let docUrl = null;
  if (body?.doc_url !== undefined && body.doc_url !== null && body.doc_url !== '') {
    if (typeof body.doc_url !== 'string' || !URL_RE.test(body.doc_url)) {
      return jsonResponse({ error: 'invalid_doc_url' }, 400);
    }
    docUrl = body.doc_url.trim();
  }

  // Validation canaux (optionnel) — whitelist drive ajouté à telegram/discord/bonzai
  const canaux = {};
  const ALLOWED_CHANNELS = ['telegram', 'discord', 'bonzai', 'drive'];
  if (body?.canaux && typeof body.canaux === 'object' && !Array.isArray(body.canaux)) {
    for (const ch of ALLOWED_CHANNELS) {
      const c = body.canaux[ch];
      if (!c || typeof c !== 'object') continue;
      const url = typeof c.url === 'string' ? c.url.trim() : '';
      if (url && !URL_RE.test(url)) {
        return jsonResponse({ error: 'invalid_canal_url', channel: ch }, 400);
      }
      if (url) {
        canaux[ch] = {
          url,
          handle: typeof c.handle === 'string' ? c.handle.slice(0, 100) : '',
        };
      }
    }
  }

  // ── Création KV ────────────────────────────────────────────────
  const now = Date.now();
  const eleve = {
    id: slug,
    slug,
    nom: nomRaw,
    email: emailRaw,
    programme: 'Piano Master',
    statut: 'actif',
    canaux: Object.keys(canaux).length ? canaux : undefined,
    createdAt: now,
    _patchedAt: new Date(now).toISOString(),
  };
  if (docUrl) {
    // Si l'admin colle une URL Google Doc complète, on extrait l'id pour
    // permettre la sync ultérieure (cf api/eleves/sync.js qui utilise doc_id).
    eleve.doc_url = docUrl;
    const m = docUrl.match(/\/document\/d\/([A-Za-z0-9_-]{20,})/);
    if (m) eleve.doc_id = m[1];
  }

  // Cleanup undefined avant put
  Object.keys(eleve).forEach(k => {
    if (eleve[k] === undefined) delete eleve[k];
  });

  try {
    await env.MASTERHUB_STUDENTS.put(`eleve:${slug}`, JSON.stringify(eleve));
  } catch (e) {
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  // Push slug dans eleves:list (lecture-modify-write atomic-ish)
  try {
    const listRaw = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const list = Array.isArray(listRaw) ? listRaw.slice() : DEFAULT_ELEVES.slice();
    if (!list.includes(slug)) {
      list.push(slug);
      await env.MASTERHUB_STUDENTS.put('eleves:list', JSON.stringify(list));
    }
  } catch (e) {
    console.warn('[eleves/POST] eleves:list update failed:', e?.message || e);
    // Non-bloquant : l'élève est créé, juste pas dans la liste publique.
    // L'admin peut re-trigger via re-création (idempotent grâce au check unicité).
  }

  // Index inverse email → slug (lookup O(1) magic link)
  try {
    await env.MASTERHUB_STUDENTS.put(`email:${emailRaw}`, JSON.stringify({ slug }));
  } catch (e) {
    console.warn('[eleves/POST] email index put failed:', e?.message || e);
  }

  return jsonResponse({ ok: true, slug, ...eleve }, 201);
}
