// ─── Roadmap 8 séances (accompagnement 2 mois, 1 séance / semaine) ─
// Source unique des parcours modèles. Exposés au front admin via
// GET /api/eleves/:slug/roadmap (champ `templates`).
//
// Parcours unique « general » (décision du 03/10). Modèle stocké dans
// eleve:<slug>.roadmap :
//   { parcours: 'general', seance_courante: 1..8,
//     seances: [{ n, titre, objectif, livrable, statut, date, note_coach }] }
// statut : 'a_venir' | 'en_cours' | 'faite'. Le statut fait foi :
// seance_courante = première séance non faite (8 si tout est fait).
// note_coach est privée : jamais renvoyée à l'élève (cf. publicRoadmap).

import { mergeStats } from './eleves-stats.js';

export const ROADMAP_SIZE = 8;
export const ROADMAP_STATUTS = ['a_venir', 'en_cours', 'faite'];

export const ROADMAP_TEMPLATES = {
  general: {
    label: 'Général',
    seances: [
      { titre: 'Onboarding & diagnostic', objectif: 'Tests : repérage de notes, oreille, accords, notions. Définir les objectifs.', livrable: '3 morceaux visés + 3 extraits actuels' },
      { titre: 'Accords essentiels', objectif: 'Accords majeurs, mineurs et de 7e ; repères visuels du clavier.', livrable: '' },
      { titre: 'Renversements & enchaînements', objectif: 'Notes communes, transitions fluides.', livrable: '' },
      { titre: 'Tonalités & degrés', objectif: 'Gammes, degrés, transposition simple.', livrable: '' },
      { titre: 'Progressions', objectif: 'Grilles « 4 accords », ii–V–I simplifié, stabilité rythmique.', livrable: '' },
      { titre: 'Couleurs', objectif: 'Accords enrichis (9, sus2/sus4) ; main gauche (fondamentale/5, accords brisés).', livrable: '' },
      { titre: 'Application', objectif: 'Morceau ou accompagnement d\'une voix : « joue moins, mais joue juste ».', livrable: '' },
      { titre: 'Bilan & performance', objectif: 'Bilan du parcours, consolidation, plan pour continuer seul.', livrable: 'Morceau joué + témoignage' },
    ],
  },
};

const LIMITS = { titre: 80, objectif: 300, livrable: 200, note_coach: 1000 };
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '').trim().slice(0, max);
}

// Le statut fait foi : seance_courante = 1re séance non faite ; une seule
// séance 'en_cours' (la courante), les autres non faites repassent 'a_venir'.
export function normalizeRoadmap(rm) {
  const seances = rm.seances.map((s, i) => ({ ...s, n: i + 1 }));
  const firstOpen = seances.find(s => s.statut !== 'faite');
  const courante = firstOpen ? firstOpen.n : ROADMAP_SIZE;
  for (const s of seances) {
    if (s.statut === 'faite') continue;
    s.statut = s.n === courante ? 'en_cours' : 'a_venir';
  }
  return { parcours: 'general', seance_courante: courante, seances };
}

// Parcours modèle, avec les `nbFaites` premières séances marquées faites.
export function buildRoadmap(nbFaites = 0) {
  const tpl = ROADMAP_TEMPLATES.general;
  const faites = Math.max(0, Math.min(ROADMAP_SIZE, Number(nbFaites) || 0));
  return normalizeRoadmap({
    seances: tpl.seances.map((t, i) => ({
      n: i + 1,
      titre: t.titre,
      objectif: t.objectif,
      livrable: t.livrable,
      statut: i < faites ? 'faite' : 'a_venir',
      date: '',
      note_coach: '',
    })),
  });
}

// Migration douce : un élève sans roadmap reçoit le parcours "general",
// séances faites = stats.nb_cours (plafonné à 8). Rien n'est écrit en KV
// tant que le coach n'a pas enregistré la roadmap ou une séance.
export function ensureRoadmap(record) {
  if (record && record.roadmap && Array.isArray(record.roadmap.seances)
      && record.roadmap.seances.length === ROADMAP_SIZE) {
    return normalizeRoadmap(record.roadmap);
  }
  const nb = Number(record?.stats?.nb_cours ?? record?.sessionCount ?? 0) || 0;
  return buildRoadmap(nb);
}

export function countFaites(roadmap) {
  return (roadmap?.seances || []).filter(s => s.statut === 'faite').length;
}

// nb_cours = nombre total de séances enregistrées dans seances:<slug>
// (record.nb_seances), sans plafond : les prolongations au-delà de 8
// comptent. Seule la progression du parcours (faites / 8) est plafonnée.
// Le compte du Google Doc reste pris en compte tant qu'il est supérieur
// (élèves suivis avant le formulaire post-séance).
export function applySeanceStats(stats, nbSeances) {
  if (!stats) return stats;
  const n = Number(nbSeances) || 0;
  if (n > 0) stats.nb_cours = Math.max(Number(stats.nb_cours) || 0, n);
  return stats;
}

// Applique une roadmap enregistrée à un record élève (copie) : stats
// construites si absentes (élève créé sans Doc), nb_cours = séances saisies.
export function withRoadmap(record, roadmap, nbSeances = record.nb_seances) {
  const stats = mergeStats(record.stats_auto_raw || { nb_cours: 0 }, record.stats_override || {});
  if (!record.stats_auto_raw && record.stats) stats.nb_cours = Number(record.stats.nb_cours) || 0;
  applySeanceStats(stats, nbSeances);
  const out = { ...record, roadmap, stats, sessionCount: stats.nb_cours };
  if (Number(nbSeances) > 0) out.nb_seances = Number(nbSeances);
  return out;
}

// Version élève : sans note_coach.
export function publicRoadmap(roadmap) {
  return {
    parcours: 'general',
    seance_courante: roadmap.seance_courante,
    total: ROADMAP_SIZE,
    faites: countFaites(roadmap),
    seances: roadmap.seances.map(s => ({
      n: s.n, titre: s.titre, objectif: s.objectif, livrable: s.livrable,
      statut: s.statut, date: s.date || '',
    })),
  };
}

// Valide une roadmap complète envoyée par l'admin. Retourne
// { roadmap } (normalisée) ou { error }.
export function validateRoadmapInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'roadmap invalide (objet attendu)' };
  if (input.parcours !== undefined && input.parcours !== 'general') return { error: 'parcours invalide (general)' };
  if (!Array.isArray(input.seances) || input.seances.length !== ROADMAP_SIZE) {
    return { error: `seances invalide (${ROADMAP_SIZE} séances attendues)` };
  }
  const seances = [];
  for (let i = 0; i < ROADMAP_SIZE; i++) {
    const s = input.seances[i];
    if (!s || typeof s !== 'object') return { error: `seances[${i}] invalide` };
    const titre = cleanText(s.titre, LIMITS.titre);
    if (!titre) return { error: `S${i + 1} : titre requis` };
    const statut = ROADMAP_STATUTS.includes(s.statut) ? s.statut : 'a_venir';
    const date = typeof s.date === 'string' && ISO_RE.test(s.date) ? s.date : '';
    seances.push({
      n: i + 1,
      titre,
      objectif: cleanText(s.objectif, LIMITS.objectif),
      livrable: cleanText(s.livrable, LIMITS.livrable),
      statut,
      date,
      note_coach: cleanText(s.note_coach, LIMITS.note_coach),
    });
  }
  return { roadmap: normalizeRoadmap({ seances }) };
}

export const ROADMAP_LIMITS = LIMITS;
