// ─── Enregistrement d'une séance (logique partagée) ──────────────
// Utilisé par POST /api/eleves/:slug/seance (publication) et
// PUT/DELETE /api/eleves/:slug/seances/:id (modification, suppression).
//
// Entrée : { date, titre, resume[], devoirs[], livrable?, note_coach? }
//   n : recalculé à chaque écriture = séances antérieures + rang
//       chronologique (un `n` envoyé par le client est ignoré).
//
// Effets :
//   - seances:<slug>  : publication = AJOUT (jamais d'écrasement) ;
//                       modification / suppression ciblées par id
//   - roadmap         : jamais touchée (parcours retiré ; données KV ignorées)
//   - derniere_seance : la plus récente de l'historique, manualEdit:true
//   - stats           : recalculées depuis l'historique (cf. _lib/eleves-stats.js)

import { parseIsoDate, computeEleveStats, seancesAnterieures } from './eleves-stats.js';

export const SEANCE_LIMITS = {
  titre: 80,
  item: 500,       // caractères par puce (résumés issus du transcripteur)
  items: 30,       // puces max par liste
  history: 200,    // séances conservées dans seances:<slug>
  livrable: 200,
  note_coach: 1000,
};

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '').trim().slice(0, max);
}

function cleanList(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(s => typeof s === 'string')
    .map(s => s.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, SEANCE_LIMITS.item))
    .filter(Boolean)
    .slice(0, SEANCE_LIMITS.items);
}

// Lit l'historique seances:<slug> (tableau, ordre chronologique croissant).
export async function readSeances(env, slug) {
  const history = await env.MASTERHUB_STUDENTS.get(`seances:${slug}`, { type: 'json' }).catch(() => null);
  return Array.isArray(history) ? history : [];
}

// Valide le corps d'une séance (publication ou modification).
// Retourne { ok: true, fields } ou { ok: false, status, error }.
export function validateSeanceBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'JSON invalide' };
  const date = typeof body.date === 'string' ? body.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseIsoDate(date) === null) {
    return { ok: false, status: 400, error: 'date invalide (YYYY-MM-DD)' };
  }
  const titre = cleanText(body.titre, SEANCE_LIMITS.titre);
  if (!titre) return { ok: false, status: 400, error: 'titre requis (1-80 caractères)' };
  const resume = cleanList(body.resume ?? []);
  const devoirs = cleanList(body.devoirs ?? []);
  if (!resume || !devoirs) return { ok: false, status: 400, error: 'resume et devoirs : listes attendues' };
  const livrable = cleanText(body.livrable, SEANCE_LIMITS.livrable);
  const note_coach = cleanText(body.note_coach, SEANCE_LIMITS.note_coach);
  return { ok: true, fields: { date, titre, resume, devoirs, livrable, note_coach } };
}

// Tri chronologique stable : date de séance, puis ordre de saisie.
function sortHistory(history) {
  return history
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.date !== b.s.date) return a.s.date < b.s.date ? -1 : 1;
      const ca = a.s.createdAt || '', cb = b.s.createdAt || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.s);
}

// Recalcule tout ce qui dépend de l'historique puis écrit seances:<slug>
// et eleve:<slug> :
//   - ordre chronologique + numéros (n = séances antérieures + rang)
//   - derniere_seance (devoirs affichés) = la plus récente de l'historique
//   - stats : nombre de séances, date de début, date de fin auto
// Retourne { ok: true, data, seances } ou { ok: false, status, error, detail }.
export async function commitHistory(env, slug, record, history) {
  history = sortHistory(history);
  if (history.length > SEANCE_LIMITS.history) history = history.slice(history.length - SEANCE_LIMITS.history);
  const anterieures = seancesAnterieures(record);
  history.forEach((s, i) => { s.n = anterieures + i + 1; });

  const now = new Date().toISOString();
  const latest = history[history.length - 1] || null;
  // Exception : une séance du Doc (sync, sans manualEdit) plus récente que
  // tout l'historique reste affichée.
  const existingDs = record.derniere_seance;
  const isDocSeance = existingDs && existingDs.manualEdit !== true;
  const keepDocSeance = isDocSeance && typeof existingDs.date === 'string'
    && (!latest || existingDs.date > latest.date);

  const updated = {
    ...record,
    stats: computeEleveStats(record, history),
    nb_seances: history.length,
    sessionCount: history.length,
    _patchedAt: now,
  };
  if (!keepDocSeance) {
    if (latest) {
      updated.derniere_seance = {
        date: latest.date,
        titre: latest.titre,
        devoirs: latest.devoirs,
        resume: latest.resume,
        manualEdit: true,
        _editedAt: now,
      };
    } else {
      // Plus aucune séance publiée : plus de « dernière séance ».
      updated.derniere_seance = null;
    }
  }

  try {
    await env.MASTERHUB_STUDENTS.put(`seances:${slug}`, JSON.stringify(history));
    await env.MASTERHUB_STUDENTS.put(`eleve:${slug}`, JSON.stringify(updated));
  } catch (e) {
    return { ok: false, status: 500, error: 'kv_put_failed', detail: e?.message || '' };
  }
  return { ok: true, data: updated, seances: history };
}

async function loadRecord(env, slug) {
  slug = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: 'invalid_slug' };
  const record = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  if (!record) return { ok: false, status: 404, error: 'Élève introuvable' };
  return { ok: true, slug, record };
}

// Valide et enregistre une nouvelle séance (ajout, jamais d'écrasement).
// Retourne { ok: true, entry, data, seances }
//       ou { ok: false, status, error, detail? }.
export async function saveSeance(env, slug, body) {
  const v = validateSeanceBody(body);
  if (!v.ok) return v;
  const r = await loadRecord(env, slug);
  if (!r.ok) return r;

  const history = await readSeances(env, r.slug);
  const entry = {
    id: crypto.randomUUID(),
    n: null,
    ...v.fields,
    createdAt: new Date().toISOString(),
  };
  history.push(entry);
  const res = await commitHistory(env, r.slug, r.record, history);
  if (!res.ok) return res;
  return { ok: true, entry, data: res.data, seances: res.seances };
}

// Remplace titre, date, résumé, devoirs, livrable, note_coach d'une séance.
// Garde id et createdAt, ajoute updatedAt.
export async function updateSeance(env, slug, id, body) {
  const v = validateSeanceBody(body);
  if (!v.ok) return v;
  const r = await loadRecord(env, slug);
  if (!r.ok) return r;

  const history = await readSeances(env, r.slug);
  const idx = history.findIndex(s => s && s.id === id);
  if (idx === -1) return { ok: false, status: 404, error: 'Séance introuvable' };
  const prev = history[idx];
  const entry = {
    ...prev,
    ...v.fields,
    id: prev.id,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  };
  history[idx] = entry;
  const res = await commitHistory(env, r.slug, r.record, history);
  if (!res.ok) return res;
  return { ok: true, entry, data: res.data, seances: res.seances };
}

// Supprime une séance de l'historique.
export async function deleteSeance(env, slug, id) {
  const r = await loadRecord(env, slug);
  if (!r.ok) return r;
  const history = await readSeances(env, r.slug);
  const idx = history.findIndex(s => s && s.id === id);
  if (idx === -1) return { ok: false, status: 404, error: 'Séance introuvable' };
  const [removed] = history.splice(idx, 1);
  const res = await commitHistory(env, r.slug, r.record, history);
  if (!res.ok) return res;
  return { ok: true, removed: { id: removed.id, date: removed.date, titre: removed.titre }, data: res.data, seances: res.seances };
}
