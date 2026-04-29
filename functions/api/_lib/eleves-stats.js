// ─── Helpers stats élèves partagés (eleves/[id].js + eleves/sync.js) ─
// C6 dedup : avant ce module, mergeStats + parseIsoDate + labelFr + computeProgressionPct
// + MONTHS_LONG_FR étaient dupliqués à l'identique entre les 2 fichiers.

const MONTHS_LONG_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

export function parseIsoDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d) ? null : d;
}

export function labelFr(iso) {
  const d = parseIsoDate(iso);
  if (!d) return '—';
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

// Admin (override) gagne TOUJOURS sur auto/LLM si défini.
// override = { date_debut?: iso, date_fin?: iso, total_cours?: int }
export function mergeStats(autoRaw, override) {
  const auto = autoRaw || {};
  const ov = override || {};
  const isSet = (v) => v !== undefined && v !== null && v !== '';

  const dateDebut = isSet(ov.date_debut) ? ov.date_debut : (auto.date_debut || null);
  const dateFin   = isSet(ov.date_fin)   ? ov.date_fin   : (auto.date_fin_prevue || auto.date_fin || null);
  const totalCours = isSet(ov.total_cours) ? Number(ov.total_cours) : 8;

  return {
    nb_cours: auto.nb_cours || 0,
    total_cours: totalCours,
    date_debut: dateDebut,
    date_debut_label: labelFr(dateDebut),
    date_fin: dateFin,
    date_fin_label: labelFr(dateFin),
    progression_pct: computeProgressionPct(dateDebut, dateFin),
    override_active: {
      date_debut:  isSet(ov.date_debut),
      date_fin:    isSet(ov.date_fin),
      total_cours: isSet(ov.total_cours),
    },
  };
}
