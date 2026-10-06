// ─── Roadmap 8 séances (accompagnement 2 mois, 1 séance / semaine) ─
// Source unique des parcours modèles. Exposés au front admin via
// GET /api/eleves/:slug/roadmap (champ `templates`).
//
// Modèle stocké dans eleve:<slug>.roadmap :
//   { parcours: 'general'|'gospel', seance_courante: 1..8,
//     seances: [{ n, titre, objectif, livrable, statut, date, note_coach }] }
// statut : 'a_venir' | 'en_cours' | 'faite'. Le statut fait foi :
// seance_courante = première séance non faite (8 si tout est fait).
// note_coach est privée : jamais renvoyée à l'élève (cf. publicRoadmap).

import { mergeStats } from './eleves-stats.js';

export const ROADMAP_SIZE = 8;
export const ROADMAP_STATUTS = ['a_venir', 'en_cours', 'faite'];

export const ROADMAP_TEMPLATES = {
  general: {
    label: 'Général (débutant / reprise)',
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
  gospel: {
    label: 'Gospel',
    seances: [
      { titre: 'Shapes & voicings utiles', objectif: 'Triades → 7e → shells (3e + 7e) → ajout de la 9.', livrable: 'I–IV–V–I propre dans 2 tonalités' },
      { titre: 'Enchaînements & voice leading', objectif: '2–5–1 et 1–6–2–5.', livrable: 'Audio « progressions »' },
      { titre: 'Degrés & repérage à l\'oreille', objectif: 'Nashville numbers, basse + guide tones.', livrable: 'Début du morceau 1' },
      { titre: 'Transposition', objectif: 'Do → Fa → Sol → Si♭.', livrable: 'Même progression dans 3 tonalités' },
      { titre: 'Couleurs gospel 1', objectif: 'sus / add9 / 7e.', livrable: 'Morceau 1 + début du morceau 2' },
      { titre: 'Couleurs gospel 2', objectif: 'dim7 de passage + chromatismes (IV → #IVdim → I, I → III7 → VI, VI → #Vdim → V).', livrable: '' },
      { titre: 'Runs & embellishments', objectif: 'Runs, appoggiatures, fills courts.', livrable: 'Morceau 3 ou arrangement du morceau 2' },
      { titre: 'Arrangement complet & performance', objectif: 'Structure intro / couplet / montée / fin, dynamique.', livrable: 'Enregistrement avant/après' },
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
  return { parcours: rm.parcours, seance_courante: courante, seances };
}

// Parcours modèle, avec les `nbFaites` premières séances marquées faites.
export function buildRoadmap(parcours, nbFaites = 0) {
  const tpl = ROADMAP_TEMPLATES[parcours] || ROADMAP_TEMPLATES.general;
  const faites = Math.max(0, Math.min(ROADMAP_SIZE, Number(nbFaites) || 0));
  return normalizeRoadmap({
    parcours: ROADMAP_TEMPLATES[parcours] ? parcours : 'general',
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
  return buildRoadmap('general', nb);
}

export function countFaites(roadmap) {
  return (roadmap?.seances || []).filter(s => s.statut === 'faite').length;
}

// Une roadmap enregistrée pilote nb_cours (= séances faites).
export function applyRoadmapStats(stats, roadmap) {
  if (!stats || !roadmap || !Array.isArray(roadmap.seances)) return stats;
  stats.nb_cours = countFaites(roadmap);
  return stats;
}

// Applique une roadmap enregistrée à un record élève (copie) : stats
// construites si absentes (élève créé sans Doc), nb_cours = séances faites.
export function withRoadmap(record, roadmap) {
  const stats = record.stats
    ? { ...record.stats }
    : mergeStats(record.stats_auto_raw || { nb_cours: 0 }, record.stats_override || {});
  applyRoadmapStats(stats, roadmap);
  return { ...record, roadmap, stats, sessionCount: stats.nb_cours };
}

// Version élève : sans note_coach.
export function publicRoadmap(roadmap) {
  return {
    parcours: roadmap.parcours,
    parcours_label: ROADMAP_TEMPLATES[roadmap.parcours]?.label || roadmap.parcours,
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
  if (!ROADMAP_TEMPLATES[input.parcours]) return { error: 'parcours invalide (general | gospel)' };
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
  return { roadmap: normalizeRoadmap({ parcours: input.parcours, seances }) };
}

export const ROADMAP_LIMITS = LIMITS;
