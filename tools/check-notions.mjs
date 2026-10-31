#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Vérifie la cohérence des fiches notions (données statiques).
//   node tools/check-notions.mjs
// Contrôles : ids uniques, familles connues, chaque fiche dans l'index
// (et inversement), related[] vers des ids existants, notes du clavier
// valides et dans la plage, status ok/draft, aucun champ de niveau.
// Avertissement (non bloquant) : fiche sans étape d'exercice en ok.
// Exit code : 0 si tout passe, 1 sinon.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const errors = [];
const fail = (msg) => errors.push(msg);
const warnings = [];
const warn = (msg) => warnings.push(msg);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { fail(`${path} : JSON illisible (${e.message})`); return null; }
}

// Aucun niveau (débutant / intermédiaire / avancé) dans les données publiées
const LEVEL_KEYS = /^(level|levels|niveau|niveaux|lvl)$/i;
const LEVEL_VALUES = /^(d[ée]butant|interm[ée]diaire|avanc[ée])$/i;
function scanLevels(node, where) {
  if (Array.isArray(node)) { node.forEach((v, i) => scanLevels(v, `${where}[${i}]`)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (LEVEL_KEYS.test(k)) fail(`${where}.${k} : champ de niveau interdit`);
      scanLevels(v, `${where}.${k}`);
    }
    return;
  }
  if (typeof node === 'string' && LEVEL_VALUES.test(node.trim())) fail(`${where} : valeur de niveau interdite (« ${node} »)`);
}

// Notes : C4, Eb4, F#5…  → numéro MIDI pour comparer à la plage
const NOTE_RE = /^([A-G])(#|b)?(\d)$/;
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(note) {
  const m = NOTE_RE.exec(note);
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

// ─── Index ─────────────────────────────────────────────────────────
const index = readJson(join(DATA, 'notions.json'));
if (!index) { console.error(errors.join('\n')); process.exit(1); }
scanLevels(index, 'notions.json');

const familyIds = new Set();
for (const f of index.families || []) {
  if (!f.id || !f.name || !f.short) fail(`notions.json : famille incomplète ${JSON.stringify(f)}`);
  if (familyIds.has(f.id)) fail(`notions.json : famille en double « ${f.id} »`);
  familyIds.add(f.id);
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const notionIds = new Set();
const withFiche = new Set();
for (const n of index.notions || []) {
  if (!n.id || !ID_RE.test(n.id)) fail(`notions.json : id invalide « ${n.id} »`);
  if (notionIds.has(n.id)) fail(`notions.json : id en double « ${n.id} »`);
  notionIds.add(n.id);
  if (!n.name) fail(`notions.json : « ${n.id} » sans nom`);
  if (!familyIds.has(n.family)) fail(`notions.json : « ${n.id} » famille inconnue « ${n.family} »`);
  if (n.fiche === true) withFiche.add(n.id);
}

// ─── Fiches ────────────────────────────────────────────────────────
const ficheDir = join(DATA, 'fiches');
const files = readdirSync(ficheDir).filter((f) => f.endsWith('.json'));
const seen = new Set();

for (const file of files) {
  const where = `fiches/${file}`;
  const f = readJson(join(ficheDir, file));
  if (!f) continue;
  scanLevels(f, where);

  if (f.id + '.json' !== file) fail(`${where} : id « ${f.id} » ≠ nom du fichier`);
  seen.add(f.id);
  if (!notionIds.has(f.id)) fail(`${where} : absente de l'index`);
  else if (!withFiche.has(f.id)) fail(`${where} : l'index ne la marque pas "fiche": true`);
  const notion = (index.notions || []).find((n) => n.id === f.id);
  if (notion && notion.family !== f.family) fail(`${where} : famille « ${f.family} » ≠ index « ${notion.family} »`);

  for (const key of ['title', 'summary', 'avoid']) {
    if (typeof f[key] !== 'string' || !f[key].trim()) fail(`${where} : champ « ${key} » manquant`);
  }
  for (const key of ['essentials', 'tips', 'exercise', 'related']) {
    if (!Array.isArray(f[key])) fail(`${where} : « ${key} » doit être un tableau`);
  }

  (f.essentials || []).forEach((e, i) => {
    if (!Array.isArray(e.parts) || !e.parts.length) fail(`${where} : essentials[${i}] sans parts`);
    (e.parts || []).forEach((p, j) => {
      if (!p.term || !p.text) fail(`${where} : essentials[${i}].parts[${j}] incomplet`);
    });
  });

  const checkStatus = (item, label) => {
    if (item.status !== 'ok' && item.status !== 'draft') fail(`${where} : ${label} status « ${item.status} » (ok ou draft attendu)`);
    if (!item.text) fail(`${where} : ${label} sans texte`);
  };
  (f.tips || []).forEach((t, i) => {
    checkStatus(t, `tips[${i}]`);
    (t.variants || []).forEach((v, j) => checkStatus(v, `tips[${i}].variants[${j}]`));
  });
  (f.exercise || []).forEach((s, i) => checkStatus(s, `exercise[${i}]`));
  if (!(f.exercise || []).some((s) => s.status === 'ok')) warn(`${where} : aucune étape d'exercice en ok (bouton Exercice masqué)`);
  if (!(f.tips || []).some((t) => t.status === 'ok')) fail(`${where} : aucune astuce en ok`);

  (f.related || []).forEach((r) => {
    if (!notionIds.has(r)) fail(`${where} : related « ${r} » n'existe pas dans l'index`);
    if (r === f.id) fail(`${where} : related pointe vers elle-même`);
  });

  const kb = f.keyboard;
  if (!kb || !Array.isArray(kb.range) || kb.range.length !== 2) { fail(`${where} : keyboard.range manquant`); continue; }
  const lo = midi(kb.range[0]);
  const hi = midi(kb.range[1]);
  if (lo === null || hi === null) fail(`${where} : keyboard.range invalide ${JSON.stringify(kb.range)}`);
  else {
    if (lo >= hi) fail(`${where} : keyboard.range à l'envers`);
    if (/[#b]/.test(kb.range[0] + kb.range[1])) fail(`${where} : keyboard.range doit commencer et finir sur une touche blanche`);
  }
  if (!Array.isArray(kb.options) || !kb.options.length) fail(`${where} : keyboard.options vide`);
  (kb.options || []).forEach((o, i) => {
    if (!o.label) fail(`${where} : keyboard.options[${i}] sans label`);
    if (!Array.isArray(o.notes) || !o.notes.length) { fail(`${where} : keyboard.options[${i}] sans notes`); return; }
    o.notes.forEach((note) => {
      const m = midi(note);
      if (m === null) fail(`${where} : note invalide « ${note} » (option ${o.label})`);
      else if (lo !== null && hi !== null && (m < lo || m > hi)) fail(`${where} : note « ${note} » hors plage ${kb.range.join('–')} (option ${o.label})`);
    });
  });
}

for (const id of withFiche) {
  if (!seen.has(id)) fail(`notions.json : « ${id} » marquée fiche mais data/fiches/${id}.json absent`);
}

if (warnings.length) console.warn(`⚠ ${warnings.length} avertissement(s) :\n- ` + warnings.join('\n- '));
if (errors.length) {
  console.error(`✗ ${errors.length} erreur(s) :\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`✓ ${notionIds.size} notions, ${familyIds.size} familles, ${files.length} fiches : tout est cohérent.`);
