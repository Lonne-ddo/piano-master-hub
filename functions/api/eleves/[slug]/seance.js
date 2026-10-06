// ─── POST /api/eleves/:slug/seance ───────────────────────────────
// Formulaire post-séance (admin uniquement, cookie mh_admin_pw).
// Body : { n?, date, titre, resume[], devoirs[], livrable?, statut?, note_coach? }
//   n       : numéro de la séance du parcours (1..8, défaut = séance courante)
//   statut  : 'faite' (défaut) | 'en_cours' — faite → la suivante passe en cours
//
// Effets :
//   - seances:<slug>  : la séance est AJOUTÉE à l'historique (jamais écrasé)
//   - roadmap         : statut/date (+ livrable, note coach si fournis) de la séance n
//   - derniere_seance : la plus récente de l'historique, manualEdit:true
//                       (prioritaire sur la sync du Google Doc)
//   - stats.nb_cours  : nombre de séances faites

import { requireAdminPassword } from '../../_lib/session.js';
import { parseIsoDate } from '../../_lib/eleves-stats.js';
import {
  ROADMAP_SIZE, ROADMAP_LIMITS, ensureRoadmap, normalizeRoadmap, withRoadmap,
} from '../../_lib/roadmap.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_ITEM = 500;      // caractères par puce (résumés issus du transcripteur)
const MAX_ITEMS = 30;
const MAX_HISTORY = 200;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '').trim().slice(0, max);
}

function cleanList(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(s => typeof s === 'string')
    .map(s => s.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, MAX_ITEM))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

export async function onRequestPost({ params, request, env }) {
  if (!(await requireAdminPassword(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return jsonResponse({ error: 'invalid_slug' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'JSON invalide' }, 400); }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'JSON invalide' }, 400);

  // ── Validation ──
  const date = typeof body.date === 'string' ? body.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseIsoDate(date) === null) {
    return jsonResponse({ error: 'date invalide (YYYY-MM-DD)' }, 400);
  }
  const titre = cleanText(body.titre, 80);
  if (!titre) return jsonResponse({ error: 'titre requis (1-80 caractères)' }, 400);
  const resume = cleanList(body.resume ?? []);
  const devoirs = cleanList(body.devoirs ?? []);
  if (!resume || !devoirs) return jsonResponse({ error: 'resume et devoirs : listes attendues' }, 400);
  const statut = body.statut === 'en_cours' ? 'en_cours' : 'faite';
  const livrable = cleanText(body.livrable, ROADMAP_LIMITS.livrable);
  const noteCoach = cleanText(body.note_coach, ROADMAP_LIMITS.note_coach);

  const record = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  if (!record) return jsonResponse({ error: 'Élève introuvable' }, 404);

  const roadmap = ensureRoadmap(record);
  const n = body.n === undefined || body.n === null ? roadmap.seance_courante : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > ROADMAP_SIZE) {
    return jsonResponse({ error: `n invalide (1..${ROADMAP_SIZE})` }, 400);
  }

  // ── Roadmap : séance n ──
  const seance = roadmap.seances[n - 1];
  seance.statut = statut;
  seance.date = date;
  if (livrable) seance.livrable = livrable;
  if (noteCoach) seance.note_coach = noteCoach;
  const nextRoadmap = normalizeRoadmap(roadmap);

  // ── Historique : ajout, jamais d'écrasement ──
  const historyKey = `seances:${slug}`;
  let history = await env.MASTERHUB_STUDENTS.get(historyKey, { type: 'json' }).catch(() => null);
  if (!Array.isArray(history)) history = [];
  const entry = {
    id: crypto.randomUUID(),
    n, date, titre, resume, devoirs, livrable, statut,
    note_coach: noteCoach,
    createdAt: new Date().toISOString(),
  };
  history.push(entry);
  // Tri chronologique stable (date de séance, puis ordre de saisie)
  history.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);

  // ── derniere_seance = la plus récente de l'historique ──
  // Exception : une séance du Doc (sync, sans manualEdit) plus récente que
  // tout l'historique reste affichée.
  const latest = history[history.length - 1];
  const existingDs = record.derniere_seance;
  const keepDocSeance = existingDs && existingDs.manualEdit !== true
    && typeof existingDs.date === 'string' && existingDs.date > latest.date;
  const updated = { ...withRoadmap(record, nextRoadmap), _patchedAt: new Date().toISOString() };
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
    return jsonResponse({ error: 'kv_put_failed', detail: e?.message || '' }, 500);
  }

  return jsonResponse({ ok: true, entry, roadmap: nextRoadmap, data: updated, seances: history });
}
