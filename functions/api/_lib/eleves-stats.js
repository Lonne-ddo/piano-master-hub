// ─── Stats élèves (eleves/[id].js, eleves/[slug]/public.js, save-seance.js) ─
// Les stats sont DÉRIVÉES de l'historique des séances publiées
// (seances:<slug>) et du type d'accompagnement de l'élève :
//   - nb_seances / nb_cours : nombre de séances publiées
//   - avec_fin (défaut) : date_debut = date de la 1re séance publiée,
//                         date_fin   = date_debut + 8 semaines,
//                         progression_pct = temps écoulé entre les deux
//   - sans_fin          : date_debut seule, pas de date de fin ni de progression
// Les surcharges manuelles (record.stats_override.date_debut / date_fin)
// restent prioritaires sur le calcul automatique.

const MONTHS_LONG_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

export const ACCOMPAGNEMENTS = ['avec_fin', 'sans_fin'];
export const DUREE_AVEC_FIN_JOURS = 8 * 7;

export function normalizeAccompagnement(v) {
  return v === 'sans_fin' ? 'sans_fin' : 'avec_fin';
}

export function parseIsoDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d) ? null : d;
}

function toIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addDaysIso(iso, days) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return toIso(d);
}

export function labelFr(iso) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return `${d.getDate()} ${MONTHS_LONG_FR[d.getMonth()]} ${d.getFullYear()}`;
}

export function computeProgressionPct(debutIso, finIso) {
  const start = parseIsoDate(debutIso);
  const end = parseIsoDate(finIso);
  if (!start || !end) return 0;
  const total = (end - start) / 86400000;
  if (total <= 0) return 0;
  const elapsed = (Date.now() - start) / 86400000;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

// Date de la 1re séance publiée (la plus ancienne valide) ou null.
function firstSeanceDate(history) {
  let first = null;
  for (const s of Array.isArray(history) ? history : []) {
    if (s && parseIsoDate(s.date) && (first === null || s.date < first)) first = s.date;
  }
  return first;
}

// Stats d'un élève à partir de son record et de son historique de séances.
export function computeEleveStats(record, history) {
  const ov = (record && record.stats_override) || {};
  const isSet = (v) => v !== undefined && v !== null && v !== '';
  const accompagnement = normalizeAccompagnement(record && record.accompagnement);
  const nb = Array.isArray(history) ? history.length : 0;

  const dateDebut = isSet(ov.date_debut) ? ov.date_debut : firstSeanceDate(history);
  let dateFin = null;
  if (accompagnement === 'avec_fin') {
    dateFin = isSet(ov.date_fin) ? ov.date_fin : (dateDebut ? addDaysIso(dateDebut, DUREE_AVEC_FIN_JOURS) : null);
  }

  return {
    accompagnement,
    nb_seances: nb,
    nb_cours: nb,
    total_cours: isSet(ov.total_cours) ? Number(ov.total_cours) : 8,
    date_debut: dateDebut || null,
    date_debut_label: labelFr(dateDebut),
    date_fin: dateFin,
    date_fin_label: labelFr(dateFin),
    progression_pct: accompagnement === 'avec_fin' ? computeProgressionPct(dateDebut, dateFin) : null,
    override_active: {
      date_debut:  isSet(ov.date_debut),
      date_fin:    accompagnement === 'avec_fin' && isSet(ov.date_fin),
      total_cours: isSet(ov.total_cours),
    },
  };
}

// Lit seances:<slug> puis calcule les stats (la progression dépend du jour :
// elle est toujours recalculée à la lecture, jamais lue depuis le KV).
export async function loadEleveStats(env, slug, record) {
  let history = [];
  try {
    const h = await env.MASTERHUB_STUDENTS.get(`seances:${slug}`, { type: 'json' });
    if (Array.isArray(h)) history = h;
  } catch { /* stats sans historique */ }
  return computeEleveStats(record, history);
}
