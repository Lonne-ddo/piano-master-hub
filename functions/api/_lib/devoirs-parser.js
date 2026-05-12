// ─── Devoirs parser (markdown regex, sans LLM) ─────────────────────
// Parse les devoirs de la SÉANCE LA PLUS RÉCENTE depuis l'export Markdown
// d'un Google Doc de suivi élève (convention : `# DD/MM` en heading H1
// pour chaque séance, sous-sections gras **Devoirs** ou **À faire**).
//
// Indépendant du sync LLM (sync.js → derniere_seance.devoirs). Plus rapide,
// pas de coût provider, mais plus fragile aux variations de formatage.

const SEANCE_HEADING_RE = /^# (\d{1,2}\/\d{1,2})\s*$/gm;
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

// Parse le markdown brut et retourne les bullets devoirs de la dernière séance.
// Retourne [] si aucune séance, aucune section devoirs, ou aucun bullet valide.
export function parseDevoirsFromDoc(md) {
  if (typeof md !== 'string' || !md.length) return [];

  // 1. Localise tous les headings de séance `# DD/MM` (avec leur offset).
  const matches = [];
  let m;
  SEANCE_HEADING_RE.lastIndex = 0;
  while ((m = SEANCE_HEADING_RE.exec(md)) !== null) {
    matches.push({ index: m.index, label: m[1] });
  }
  if (!matches.length) return [];

  // 2. Prendre la DERNIÈRE séance (ordre d'apparition, Lonne ajoute en bas).
  const last = matches[matches.length - 1];
  const blockStart = last.index;
  const blockEnd = md.length;
  const block = md.slice(blockStart, blockEnd);

  // 3. Localise la section devoirs dans ce bloc.
  const devLabelMatch = DEVOIRS_LABEL_RE.exec(block);
  if (!devLabelMatch) return [];
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
  return bullets;
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
// Timeout 8s. Retourne { bullets: string[], docId: string|null, status: 'ok'|'error'|'no_doc_id', error?: string }.
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
    const bullets = parseDevoirsFromDoc(md);
    return { bullets, docId, status: 'ok' };
  } catch (e) {
    clearTimeout(tid);
    return { bullets: [], docId, status: 'error', error: e?.message || 'fetch_failed' };
  }
}
