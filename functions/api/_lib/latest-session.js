// ─── Sélection de la séance la plus récente (source unique de vérité) ──
// Découpe un export Google Doc (txt OU md) en séances délimitées par des
// headings de date, et sélectionne DÉTERMINISTIQUEMENT le bloc de la séance
// de date MAX — indépendamment de l'ordre d'apparition des séances dans le
// doc (les onglets Google Docs ne sont pas forcément triés par date).
//
// Consommé par sync.js (derniere_seance) ET devoirs-parser.js (devoirs).
// AUCUNE logique de sélection ne doit être dupliquée ailleurs.
//
// Un heading de séance = une ligne qui ne contient QUE une date "JJ/MM" ou
// "JJ/MM/AAAA", éventuellement préfixée de '#'/espaces (markdown) ou du BOM
// (txt). Exemples captés : "# 17/07", "17/07", "## 8/3/24", "﻿17/07".
// Rejeté : "Memo", "Onglet 1", "07/05 quelque chose" (texte après la date).
//
// NB : \s en JS inclut le BOM (﻿), donc "[\s#]*" consomme le BOM que
// Google place en tête du premier onglet dans l'export txt.
const SESSION_HEADING_RE = /^[\s#]*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*$/gm;

// Garde-fou rollover décembre→janvier : si une date sans année tombe à plus de
// 7 jours dans le futur (année courante supposée), on retire 1 an.
const FUTURE_TOLERANCE_MS = 7 * 24 * 3600 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }
function isoOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Convertit (jour, mois, anneeRaw) en Date locale, ou null si date invalide.
// anneeRaw null → année courante avec garde-fou rollover (cf. ci-dessus).
function toDate(jour, mois, anneeRaw, now) {
  let annee;
  if (anneeRaw != null) {
    annee = anneeRaw < 100 ? anneeRaw + 2000 : anneeRaw; // "24"→2024, "26"→2026
  } else {
    annee = now.getFullYear();
    const candidate = new Date(annee, mois - 1, jour);
    if (candidate.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) {
      annee -= 1; // ex : on est en janvier, heading "# 28/12" → année précédente
    }
  }
  const d = new Date(annee, mois - 1, jour);
  // Rejette les dates impossibles (ex 31/02 → JS déborde sur mars).
  if (d.getMonth() !== mois - 1 || d.getDate() !== jour) return null;
  return d;
}

// Collecte tous les headings de séance datés (avec offset) présents dans le doc.
// Exporté pour usage éventuel ; la sélection passe par selectLatestSession.
export function findSessionHeadings(docText, now = new Date()) {
  const heads = [];
  if (typeof docText !== 'string' || !docText.length) return heads;
  SESSION_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = SESSION_HEADING_RE.exec(docText)) !== null) {
    const jour = parseInt(m[1], 10);
    const mois = parseInt(m[2], 10);
    if (jour < 1 || jour > 31 || mois < 1 || mois > 12) continue;
    const anneeRaw = m[3] != null ? parseInt(m[3], 10) : null;
    const date = toDate(jour, mois, anneeRaw, now);
    if (!date) continue;
    heads.push({
      date,
      index: m.index,
      end: m.index + m[0].length,
      headingRaw: m[0].replace(/^[\s#]+/, '').trim(), // ex "17/07"
    });
  }
  return heads;
}

// Sélectionne la séance de date MAX et renvoie son bloc de texte.
// Retour : { date: 'YYYY-MM-DD'|null, headingRaw: string|null,
//            block: string|null, error: string|null }.
//   - error = 'empty_doc'        : docText vide/non-string
//   - error = 'no_dated_heading' : aucun heading daté (ex doc "Memo" seul)
// Dans ces cas block/date sont null → l'appelant DOIT préserver l'existant
// (ne pas écraser le KV, ne pas sélectionner de bloc arbitraire).
export function selectLatestSession(docText, opts = {}) {
  if (typeof docText !== 'string' || !docText.length) {
    return { date: null, headingRaw: null, block: null, error: 'empty_doc' };
  }
  const now = opts.now || new Date();
  const heads = findSessionHeadings(docText, now);
  if (!heads.length) {
    return { date: null, headingRaw: null, block: null, error: 'no_dated_heading' };
  }

  // Date MAX ; en cas d'égalité de date, on garde la dernière par apparition.
  let best = heads[0];
  for (let i = 1; i < heads.length; i++) {
    const h = heads[i];
    const dt = h.date.getTime() - best.date.getTime();
    if (dt > 0 || (dt === 0 && h.index > best.index)) best = h;
  }

  // Bloc = du heading choisi jusqu'au PROCHAIN heading dans l'ordre du doc
  // (plus petit offset > best.index), ou fin du doc. Les séances sont des
  // régions de texte contiguës, quel que soit l'ordre chronologique.
  let blockEnd = docText.length;
  for (const h of heads) {
    if (h.index > best.index && h.index < blockEnd) blockEnd = h.index;
  }

  return {
    date: isoOf(best.date),
    headingRaw: best.headingRaw,
    block: docText.slice(best.index, blockEnd),
    error: null,
  };
}
