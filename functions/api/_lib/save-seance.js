// ─── Enregistrement d'une séance (logique partagée) ──────────────
// Utilisé par POST /api/eleves/:slug/seance (formulaire post-séance admin).
//
// Entrée : { date, titre, resume[], devoirs[], livrable?, note_coach? }
//   n : calculé ici = nombre de séances déjà enregistrées + 1 (un `n`
//       envoyé par le client est ignoré).
//
// Effets :
//   - seances:<slug>  : la séance est AJOUTÉE à l'historique (jamais écrasé)
//   - roadmap         : statut/date (+ livrable, note coach si fournis) de la séance n
//   - derniere_seance : la plus récente de l'historique, manualEdit:true
//   - stats.nb_cours  : nombre total de séances enregistrées (sans plafond)

import { parseIsoDate } from './eleves-stats.js';
import {
  ROADMAP_SIZE, ROADMAP_LIMITS, ensureRoadmap, normalizeRoadmap, withRoadmap,
} from './roadmap.js';

export const SEANCE_LIMITS = {
  titre: 80,
  item: 500,       // caractères par puce (résumés issus du transcripteur)
  items: 30,       // puces max par liste
  history: 200,    // séances conservées dans seances:<slug>
  livrable: ROADMAP_LIMITS.livrable,
  note_coach: ROADMAP_LIMITS.note_coach,
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

// Valide et enregistre une séance.
// Retourne { ok: true, entry, roadmap, data, seances }
//       ou { ok: false, status, error, detail? }.
export async function saveSeance(env, slug, body) {
  slug = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: 'invalid_slug' };
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'JSON invalide' };

  // ── Validation ──
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
  const noteCoach = cleanText(body.note_coach, SEANCE_LIMITS.note_coach);

  const record = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  if (!record) return { ok: false, status: 404, error: 'Élève introuvable' };

  // ── Numéro : séances déjà enregistrées + 1 ──
  const historyKey = `seances:${slug}`;
  let history = await readSeances(env, slug);
  const n = history.length + 1;

  // ── Roadmap : séance n si elle existe dans le parcours ──
  const roadmap = ensureRoadmap(record);
  if (n <= ROADMAP_SIZE) {
    const seance = roadmap.seances[n - 1];
    seance.statut = 'faite';
    seance.date = date;
    if (livrable) seance.livrable = livrable;
    if (noteCoach) seance.note_coach = noteCoach;
  }
  const nextRoadmap = normalizeRoadmap(roadmap);

  // ── Historique : ajout, jamais d'écrasement ──
  const entry = {
    id: crypto.randomUUID(),
    n, date, titre, resume, devoirs, livrable,
    note_coach: noteCoach,
    createdAt: new Date().toISOString(),
  };
  history.push(entry);
  // Tri chronologique stable (date de séance, puis ordre de saisie)
  history.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  if (history.length > SEANCE_LIMITS.history) history = history.slice(history.length - SEANCE_LIMITS.history);

  // ── derniere_seance = la plus récente de l'historique ──
  // Exception : une séance du Doc (sync, sans manualEdit) plus récente que
  // tout l'historique reste affichée.
  const latest = history[history.length - 1];
  const existingDs = record.derniere_seance;
  const keepDocSeance = existingDs && existingDs.manualEdit !== true
    && typeof existingDs.date === 'string' && existingDs.date > latest.date;
  const updated = { ...withRoadmap(record, nextRoadmap, history.length), _patchedAt: new Date().toISOString() };
  if (!keepDocSeance) {
    updated.derniere_seance = {
      date: latest.date,
      titre: latest.titre,
      devoirs: latest.devoirs,
      resume: latest.resume,
      manualEdit: true,
      _editedAt: new Date().toISOString(),
    };
  }

  try {
    await env.MASTERHUB_STUDENTS.put(historyKey, JSON.stringify(history));
    await env.MASTERHUB_STUDENTS.put(`eleve:${slug}`, JSON.stringify(updated));
  } catch (e) {
    return { ok: false, status: 500, error: 'kv_put_failed', detail: e?.message || '' };
  }

  return { ok: true, entry, roadmap: nextRoadmap, data: updated, seances: history };
}
