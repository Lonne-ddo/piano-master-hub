// ─── Helpers Répertoire élève (Library de référence) ─────────────
// Stockage : MASTERHUB_HISTORY, clé `repertoire:<slug>`, valeur
// { morceaux: [ ... ] }. Array stocké en bloc ; tri createdAt desc à
// la lecture. Schéma morceau validé strictement côté serveur.

const DEFAULT_ELEVES = ['japhet', 'messon', 'dexter', 'tara'];

export const STATUTS = ['en_cours', 'maitrise', 'bonus'];
const DEFAULT_STATUT = 'en_cours';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// YouTube : watch / youtu.be / embed / shorts (id 11 chars).
const YOUTUBE_RE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^&]*&)*v=|embed\/|shorts\/|live\/)|youtu\.be\/)[\w-]{11}(?:[?&#].*)?$/i;
const HTTP_URL_RE = /^https?:\/\/.+/i;

// ─── ID nanoid 12 chars [A-Za-z0-9_-] (cohérent analyse/_helpers) ──
export function genId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += alphabet[buf[i] & 63];
  return out;
}

export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}

// ─── Slug whitelist (cohérent eleves/index + analyse/_helpers) ────
export async function loadValidSlugs(env) {
  if (!env.MASTERHUB_STUDENTS) return DEFAULT_ELEVES.slice();
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (Array.isArray(list) && list.length) {
      return list.map((s) => String(s).toLowerCase()).filter(Boolean);
    }
    return DEFAULT_ELEVES.slice();
  } catch {
    return DEFAULT_ELEVES.slice();
  }
}

export async function isValidSlug(slug, env) {
  const valid = await loadValidSlugs(env);
  return valid.includes(String(slug || '').toLowerCase());
}

// ─── Lecture / écriture KV ────────────────────────────────────────
// readRepertoire renvoie TOUJOURS un array (vide si absent/corrompu),
// trié createdAt desc.
export async function readRepertoire(env, slug) {
  if (!env.MASTERHUB_HISTORY) return [];
  let raw;
  try {
    raw = await env.MASTERHUB_HISTORY.get(`repertoire:${slug}`, { type: 'json' });
  } catch {
    return [];
  }
  const arr = raw && Array.isArray(raw.morceaux) ? raw.morceaux : [];
  return arr.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function writeRepertoire(env, slug, morceaux) {
  await env.MASTERHUB_HISTORY.put(
    `repertoire:${slug}`,
    JSON.stringify({ morceaux }),
  );
}

// ─── Normalisation des ressources ─────────────────────────────────
// Renvoie { value } (objet resources normalisé) ou { error }.
// `base` = resources existantes pour un merge partiel (PATCH).
function normalizeResources(input, base) {
  const out = {
    analyse_id: base?.analyse_id ?? null,
    stems_ids: Array.isArray(base?.stems_ids) ? base.stems_ids.slice() : [],
    youtube_url: base?.youtube_url ?? null,
    grille_image_url: base?.grille_image_url ?? null,
  };
  if (input === undefined) return { value: out };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'resources doit être un objet' };
  }

  if ('analyse_id' in input) {
    const v = input.analyse_id;
    if (v === null || v === '') out.analyse_id = null;
    else if (typeof v === 'string' && v.length <= 64) out.analyse_id = v;
    else return { error: 'resources.analyse_id invalide' };
  }

  if ('stems_ids' in input) {
    const v = input.stems_ids;
    if (v === null) out.stems_ids = [];
    else if (Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length <= 64)) {
      out.stems_ids = v.slice(0, 50);
    } else return { error: 'resources.stems_ids doit être un tableau de strings' };
  }

  if ('youtube_url' in input) {
    const v = input.youtube_url;
    if (v === null || v === '') out.youtube_url = null;
    else if (typeof v === 'string' && YOUTUBE_RE.test(v.trim())) out.youtube_url = v.trim();
    else return { error: 'resources.youtube_url : URL YouTube invalide' };
  }

  if ('grille_image_url' in input) {
    const v = input.grille_image_url;
    if (v === null || v === '') out.grille_image_url = null;
    else if (typeof v === 'string' && HTTP_URL_RE.test(v.trim()) && v.length <= 2048) {
      out.grille_image_url = v.trim();
    } else return { error: 'resources.grille_image_url : URL invalide (http/https)' };
  }

  return { value: out };
}

// ─── Validation + normalisation d'un morceau ──────────────────────
// mode 'create' : construit un morceau complet (id + timestamps).
// mode 'patch'  : applique les champs présents sur `existing`.
// Renvoie { value: morceau } ou { error: string }.
export function buildMorceau(body, { mode, existing } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'corps JSON invalide' };
  }
  const isCreate = mode === 'create';
  const out = isCreate ? {} : { ...existing };

  // titre
  if (isCreate || body.titre !== undefined) {
    const titre = typeof body.titre === 'string' ? body.titre.trim() : '';
    if (!titre || titre.length < 1) return { error: 'titre requis (≥ 1 caractère)' };
    if (titre.length > 200) return { error: 'titre trop long (max 200)' };
    out.titre = titre;
  }

  // tonalite (optionnel)
  if (body.tonalite !== undefined) {
    if (body.tonalite === null || body.tonalite === '') {
      out.tonalite = null;
    } else if (typeof body.tonalite === 'string' && body.tonalite.trim().length <= 60) {
      out.tonalite = body.tonalite.trim();
    } else return { error: 'tonalite invalide (max 60 caractères)' };
  } else if (isCreate) {
    out.tonalite = null;
  }

  // date_debut (required, ISO)
  if (isCreate || body.date_debut !== undefined) {
    const d = typeof body.date_debut === 'string' ? body.date_debut.trim() : '';
    if (!ISO_DATE_RE.test(d) || Number.isNaN(new Date(d + 'T00:00:00Z').getTime())) {
      return { error: 'date_debut invalide (format YYYY-MM-DD requis)' };
    }
    out.date_debut = d;
  }

  // statut (enum)
  if (isCreate || body.statut !== undefined) {
    const s = body.statut === undefined ? DEFAULT_STATUT : body.statut;
    if (!STATUTS.includes(s)) {
      return { error: `statut invalide (attendu : ${STATUTS.join(', ')})` };
    }
    out.statut = s;
  }

  // notes (optionnel multi-ligne)
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') {
      out.notes = null;
    } else if (typeof body.notes === 'string' && body.notes.length <= 5000) {
      out.notes = body.notes;
    } else return { error: 'notes invalide (max 5000 caractères)' };
  } else if (isCreate) {
    out.notes = null;
  }

  // resources
  if (isCreate || body.resources !== undefined) {
    const res = normalizeResources(body.resources, isCreate ? null : existing?.resources);
    if (res.error) return { error: res.error };
    out.resources = res.value;
  }

  // Timestamps + id
  const now = Date.now();
  if (isCreate) {
    out.id = genId();
    out.createdAt = now;
    out.updatedAt = now;
  } else {
    out.updatedAt = now;
  }

  return { value: out };
}
