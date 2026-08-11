// ─── Devoirs parser (markdown regex, sans LLM) ─────────────────────
// Parse les devoirs de la SÉANCE LA PLUS RÉCENTE depuis l'export Markdown
// d'un Google Doc de suivi élève (convention : `# DD/MM` en heading H1
// pour chaque séance, sous-sections gras **Devoirs** ou **À faire**).
//
// La sélection "quelle séance est la plus récente" est déléguée à
// _lib/latest-session.js (source unique de vérité, tri par date MAX — pas par
// ordre d'apparition). Ici on ne fait plus qu'extraire les bullets devoirs du
// bloc sélectionné.
//
// Indépendant du sync LLM (sync.js → derniere_seance.devoirs). Plus rapide,
// pas de coût provider, mais plus fragile aux variations de formatage.

import { selectLatestSession } from './latest-session.js';

const DEVOIRS_LABEL_RE = /\*\*\s*(?:✅\s*)?(?:Devoirs|À\s*faire|A\s*faire)\s*\*\*/i;
const BULLET_RE = /^\s*[-*]\s+(.+)$/gm;
const NEXT_BOLD_SECTION_RE = /^\*\*[^*\n]+\*\*/m;
const NEXT_HEADING_RE = /^#\s/m;
const DOC_ID_RE = /\/document\/d\/([a-zA-Z0-9_-]+)/;

const FETCH_TIMEOUT_MS = 8000;

// Nettoie un bullet : strip gras/italique/liens markdown, trim.
function cleanBullet(raw) {
  let s = String(raw || '');
  // Liens [texte](url) → texte
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Gras **x** ou __x__ → x
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // Italique *x* ou _x_ → x (après gras pour ne pas casser)
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');
  // Codes inline `x` → x
  s = s.replace(/`([^`]+)`/g, '$1');
  // Trim
  return s.trim();
}

// Parse le markdown brut et retourne les devoirs de la séance la plus récente.
// Retour : { bullets: string[], sessionDate: string|null, headingRaw: string|null,
//            found: boolean }.
//   - found=false → aucun heading de séance daté (ou doc vide). L'appelant DOIT
//     préserver l'existant (ne pas écraser avec des bullets vides).
//   - found=true, bullets=[] → séance trouvée mais sans section devoirs (légitime).
export function parseDevoirsFromDoc(md) {
  const empty = { bullets: [], sessionDate: null, headingRaw: null, found: false };
  if (typeof md !== 'string' || !md.length) return empty;

  // 1-2. Sélection de la séance la plus récente (date MAX) — helper partagé.
  const latest = selectLatestSession(md);
  if (!latest.block) return empty; // no_dated_heading / empty_doc
  const block = latest.block;
  const found = { sessionDate: latest.date, headingRaw: latest.headingRaw, found: true };

  // 3. Localise la section devoirs dans ce bloc.
  const devLabelMatch = DEVOIRS_LABEL_RE.exec(block);
  if (!devLabelMatch) return { bullets: [], ...found };
  const devStart = devLabelMatch.index + devLabelMatch[0].length;

  // 4. Détermine la fin de la section : prochaine section gras OU prochain
  //    heading # OU fin de bloc.
  const tail = block.slice(devStart);
  const nextBold = NEXT_BOLD_SECTION_RE.exec(tail);
  const nextHead = NEXT_HEADING_RE.exec(tail);
  let endRel = tail.length;
  if (nextBold && nextBold.index < endRel) endRel = nextBold.index;
  if (nextHead && nextHead.index < endRel) endRel = nextHead.index;
  const section = tail.slice(0, endRel);

  // 5. Extrait les bullets `- ...` ou `* ...` (1 niveau, sous-bullets aplatis).
  const bullets = [];
  BULLET_RE.lastIndex = 0;
  let b;
  while ((b = BULLET_RE.exec(section)) !== null) {
    const cleaned = cleanBullet(b[1]);
    if (cleaned.length >= 3) bullets.push(cleaned);
  }
  return { bullets, ...found };
}

// Extrait l'ID Google Doc d'une URL.
// Accepte https://docs.google.com/document/d/{id}/... ou variantes.
export function extractDocId(urlOrId) {
  if (typeof urlOrId !== 'string') return null;
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;
  // Si déjà un ID brut (alphanumeric + - _ , typiquement 20-60 chars)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  const m = DOC_ID_RE.exec(trimmed);
  return m ? m[1] : null;
}

// Fetch le Google Doc en markdown + parse devoirs.
// Timeout 8s. Retourne { bullets: string[], docId: string|null,
//   status: 'ok'|'error'|'no_doc_id'|'no_session', sessionDate?: string, error?: string }.
//   - status='no_session' : doc récupéré mais aucun heading de séance daté →
//     l'appelant préserve l'existant (stale-while-error), comme pour 'error'.
export async function fetchAndParseDevoirs(urlOrId) {
  const docId = extractDocId(urlOrId);
  if (!docId) {
    return { bullets: [], docId: null, status: 'no_doc_id' };
  }
  const url = `https://docs.google.com/document/d/${docId}/export?format=md`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);
    if (!resp.ok) {
      return { bullets: [], docId, status: 'error', error: `HTTP ${resp.status}` };
    }
    const md = await resp.text();
    const parsed = parseDevoirsFromDoc(md);
    if (!parsed.found) {
      return { bullets: [], docId, status: 'no_session', error: 'no_dated_heading' };
    }
    return { bullets: parsed.bullets, docId, status: 'ok', sessionDate: parsed.sessionDate };
  } catch (e) {
    clearTimeout(tid);
    return { bullets: [], docId, status: 'error', error: e?.message || 'fetch_failed' };
  }
}
