// ─── extractJSON robuste 3-level pour LLM responses ─────────────
// D2 dedup : sync.js avait une version 3-level (parse direct → fence strip
// → balanced + sanitize), [id].js avait une version simple qui retournait
// une string. Ce module unifie sur la version 3-level qui retourne un objet.

function extractBalancedJson(s) {
  const first = s.indexOf('{');
  if (first < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = first; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(first, i + 1);
    }
  }
  return null;
}

function sanitizeJson(s) {
  let out = s;
  // Retire commentaires // (fin de ligne) et /* */
  out = out.replace(/\/\/[^\n\r]*/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // Guillemets typographiques → droits
  out = out.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // Trailing commas avant } ou ]
  out = out.replace(/,(\s*[\]}])/g, '$1');
  return out;
}

// Retourne directement l'objet parsé (pas une string).
// Throw avec head/tail diagnostic si tous les niveaux échouent.
export function extractJSON(rawText) {
  if (!rawText) throw new Error('extractJSON: empty input');
  const original = String(rawText);
  let s = original.trim();

  // Niveau 1 : parse direct
  try { return JSON.parse(s); } catch (_) {}

  // Niveau 1.5 : retirer fences markdown ```json ... ```
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) {}
    s = fence[1].trim();
  } else {
    s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  // Niveau 2 : extraire le premier {...} équilibré
  const balanced = extractBalancedJson(s);
  if (balanced) {
    try { return JSON.parse(balanced); } catch (_) {}
    // Niveau 3 : sanitize puis reparse
    try { return JSON.parse(sanitizeJson(balanced)); } catch (_) {}
  }

  // Niveau 3b : sanitize sur s direct
  try { return JSON.parse(sanitizeJson(s)); } catch (_) {}

  // Échec total : erreur explicite avec head/tail pour diagnostic
  const head = original.slice(0, 200).replace(/\n/g, ' ');
  const tail = original.length > 200 ? original.slice(-200).replace(/\n/g, ' ') : '';
  throw new Error(`JSON parse failed after 3 levels. length=${original.length} head="${head}" tail="${tail}"`);
}
