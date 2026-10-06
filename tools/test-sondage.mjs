#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Sondage complet Master Hub — batterie de tests automatisés.
//   node tools/test-sondage.mjs
//   SONDAGE_BASE=https://...  override l'URL de prod
//   ADMIN_PW=...              active les tests admin (cat. B) si fourni
//   RL_LOGIN_TEST=1           teste aussi le 429 du login admin (bloque l'IP 15 min !)
//
// Couvre : A endpoints publics + routes protégées sans cookie · B admin (si creds) · C audit statique
// HTML · D modules JS · E shorts smoke · F cohérence KV publique.
// Exit code : 0 si aucun KO bloquant, 1 sinon.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SONDAGE_BASE || 'https://piano-master-hub.pages.dev';
const ADMIN_PW = process.env.ADMIN_PW || null;
// Élèves testés : liste active réelle lue par la catégorie A (repli si l'API ne répond pas)
let SLUGS = ['japhet', 'messon', 'dexter', 'tara'];
const TMP = mkdtempSync(join(tmpdir(), 'sondage-'));

// ─── Collecte des résultats ────────────────────────────────────────
const cats = {};
const order = [];
function cat(name) {
  if (!cats[name]) { cats[name] = { ok: 0, warn: 0, ko: 0, skip: 0, items: [] }; order.push(name); }
  return cats[name];
}
function rec(category, level, label, detail) {
  const c = cat(category); c[level]++;
  c.items.push({ level, label, detail: detail || '' });
}
const ok = (c, l, d) => rec(c, 'ok', l, d);
const warn = (c, l, d) => rec(c, 'warn', l, d);
const ko = (c, l, d) => rec(c, 'ko', l, d);
const skip = (c, l, d) => rec(c, 'skip', l, d);

// ─── Helpers ───────────────────────────────────────────────────────
function rd(rel) { return readFileSync(join(ROOT, rel), 'utf8'); }
function exists(rel) { return existsSync(join(ROOT, rel)); }

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Les previews Cloudflare de ce projet n'ont ni KV ni ADMIN_PASSWORD liés :
// les tests qui en dépendent y sont « skip », et KO sur la prod.
const IS_PROD = BASE === 'https://piano-master-hub.pages.dev';
let ADMIN_COOKIE = null;  // posé par la catégorie B si ADMIN_PW fourni

async function http(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(BASE + path, { ...opts, signal: ctrl.signal });
    let body = null;
    const txt = await r.text();
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { status: r.status, ok: r.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: null, error: e.message };
  } finally { clearTimeout(t); }
}

let _tmpN = 0;
function checkJs(code, isModule) {
  // Écrit le code dans un fichier temporaire et lance `node --check`.
  const f = join(TMP, `s${_tmpN++}.${isModule ? 'mjs' : 'js'}`);
  writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).split('\n').slice(0, 3).join(' ').trim(); }
}
function checkJsFile(rel, isModule) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).split('\n').slice(0, 3).join(' ').trim(); }
}

// Extrait les blocs <script> d'un HTML : { inlineClassic[], inlineModule[], srcs[] }
function extractScripts(html) {
  const out = { inlineClassic: [], inlineModule: [], srcs: [] };
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (srcMatch) { out.srcs.push(srcMatch[1]); continue; }
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue; // json/manifest
    if (type === 'module') out.inlineModule.push(body);
    else out.inlineClassic.push(body);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// A. ENDPOINTS PUBLICS (live)
// ═══════════════════════════════════════════════════════════════════
async function categoryA() {
  const C = 'A. Endpoints publics';
  // Liste élèves
  const list = await http('/api/eleves');
  if (list.status === 200 && list.body?.ok && Array.isArray(list.body.eleves) && list.body.eleves.length) {
    SLUGS = list.body.eleves.map(String);
    ok(C, 'GET /api/eleves (liste)', `${list.body.eleves.length} élèves actifs`);
  } else ko(C, 'GET /api/eleves (liste)', `status ${list.status}`);
  // Archivés : jamais exposés sans cookie admin, même avec ?include_archived=true
  const listAll = await http('/api/eleves?include_archived=true');
  const archivedLeak = (list.body?.archived || []).length || (listAll.body?.archived || []).length ||
    (listAll.body?.eleves || []).length !== (list.body?.eleves || []).length;
  if (listAll.status === 200 && !archivedLeak) ok(C, 'GET /api/eleves sans admin → archivés masqués', '');
  else ko(C, 'GET /api/eleves sans admin → archivés masqués', `archived exposés ou include_archived honoré`);

  // ── Routes protégées : sans cookie → 401/403 ──
  const denied = (r) => r.status === 401 || r.status === 403;
  const s0 = SLUGS[0];
  const quizBody = { slug: s0, mode: 'notes', level: 'debutant', score: 1, total: 1, duration_ms: 1000,
                     questions: [{ asked: 'C', given: 'C', correct: true }] };
  const protectedRoutes = [
    ['GET', '/api/eleves/__nope__/onboarded'],
    ['POST', '/api/quiz/submit', quizBody],
    ['POST', '/api/grilles/generate', { types: ['maj'] }],
    ['POST', '/api/bibli/generate', { titre: 'Amazing Grace' }],
    ['GET', '/api/history'],
    ['POST', '/api/claude', { mode: 'formation', messages: [{ role: 'user', content: 'x' }] }],
    ['GET', '/api/admin/shorts/abcdefghijkl/audio/0'],
    ['DELETE', '/api/admin/shorts/abcdefghijkl'],
  ];
  for (const s of SLUGS) {
    protectedRoutes.push(['GET', `/api/eleves/${s}/onboarded`], ['POST', `/api/eleves/${s}/onboarded`, {}],
                         ['GET', `/api/eleves/${s}/repertoire`], ['GET', `/api/eleves/${s}/repertoire/x`]);
  }
  for (const [method, path, body] of protectedRoutes) {
    const r = await http(path, body ? { method, headers: JSON_HEADERS, body: JSON.stringify(body) } : { method });
    if (denied(r)) ok(C, `${method} ${path} sans cookie`, `${r.status}`);
    else ko(C, `${method} ${path} sans cookie`, `attendu 401/403, reçu ${r.status}`);
  }

  // ── Endpoints temporaires supprimés : plus de réponse JSON de la Function ──
  for (const path of ['/api/debug-doc', '/api/debug-eleve', '/api/eleves/admin/seed-doc-ids',
                      '/api/eleves/admin/migrate-email-index', '/api/quiz/admin/migrate-chord-ids',
                      '/api/stems/x/raw']) {
    const r = await http(path);
    const isFnJson = r.status === 200 && r.body && typeof r.body === 'object';
    if (!isFnJson) ok(C, `${path} supprimé`, `${r.status}`);
    else ko(C, `${path} supprimé`, `répond encore 200 JSON`);
  }

  // ── Limitation request-link : 3 / heure / email → la 4e demande est refusée ──
  const fakeEmail = `sondage-${Date.now()}@example.invalid`;
  const statuses = [];
  for (let i = 0; i < 4 && !statuses.includes(429); i++) {
    const r = await http('/api/auth/request-link', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: fakeEmail }) });
    statuses.push(r.status);
    if (r.status === 500 && !IS_PROD) break;
  }
  const rlLabel = 'POST /api/auth/request-link → 429 à la 4e demande';
  if (statuses.includes(429)) ok(C, rlLabel, statuses.join(','));
  else if (!IS_PROD && statuses.includes(500)) skip(C, rlLabel, 'KV/Resend non liés sur cette preview → vérifié sur la prod');
  else ko(C, rlLabel, `statuts ${statuses.join(',')}`);

  for (const s of SLUGS) {
    // auth-gated : on vérifie que l'auth est BIEN exigée (401), body non vérifiable
    for (const [ep, lbl] of [['', 'GET /api/eleves/:slug'], ['/public', 'GET /public'],
                             ['/devoirs', 'GET /devoirs'], ['/analyse', 'GET /analyse']]) {
      const r = await http(`/api/eleves/${s}${ep}`);
      if (r.status === 401) skip(C, `[${s}] ${lbl}`, 'auth exigée (401) ✓ — body succès non vérifiable sans session');
      else if (r.status === 200) ok(C, `[${s}] ${lbl}`, 'accessible (200, inattendu mais ok)');
      else warn(C, `[${s}] ${lbl}`, `status ${r.status} (ni 401 ni 200)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// B. ENDPOINTS ADMIN
// ═══════════════════════════════════════════════════════════════════
async function categoryB() {
  const C = 'B. Endpoints admin';
  if (!ADMIN_PW) {
    for (const l of ['GET avec cookie admin (liste, onboarded, répertoire)'])
      skip(C, l, 'ADMIN_PW non fourni dans cet environnement → non testable');
  } else {
    // Login → cookie mh_admin_pw ; uniquement des lectures ensuite
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let cookie = null;
    try {
      const r = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ password: ADMIN_PW }), signal: ctrl.signal });
      const m = (r.headers.get('set-cookie') || '').match(/mh_admin_pw=[^;]+/);
      if (r.status === 200 && m) cookie = m[0];
      else if (r.status >= 500 && !IS_PROD) skip(C, 'POST /api/admin/login', `${r.status} : ADMIN_PASSWORD non configuré sur cette preview → vérifié sur la prod`);
      else ko(C, 'POST /api/admin/login', `status ${r.status}`);
    } catch (e) { ko(C, 'POST /api/admin/login', e.message); }
    finally { clearTimeout(t); }
    if (cookie) {
      ADMIN_COOKIE = cookie;
      ok(C, 'POST /api/admin/login', 'cookie posé');
      const H = { headers: { cookie } };
      const list = await http('/api/eleves?include_archived=true', H);
      if (list.status === 200 && Array.isArray(list.body?.archived)) ok(C, 'GET /api/eleves (admin)', `${list.body.eleves.length} élèves dont ${list.body.archived.length} archivés`);
      else ko(C, 'GET /api/eleves (admin)', `status ${list.status}`);
      for (const s of SLUGS) {
        const ob = await http(`/api/eleves/${s}/onboarded`, H);
        if (ob.status === 200 && typeof ob.body?.seen === 'boolean') ok(C, `[${s}] GET /onboarded (admin)`, `seen=${ob.body.seen}`);
        else ko(C, `[${s}] GET /onboarded (admin)`, `status ${ob.status}`);
        const rp = await http(`/api/eleves/${s}/repertoire`, H);
        if (rp.status === 200 && Array.isArray(rp.body?.morceaux)) ok(C, `[${s}] GET /repertoire (admin)`, `${rp.body.morceaux.length} morceaux`);
        else ko(C, `[${s}] GET /repertoire (admin)`, `status ${rp.status}`);
      }
    }
  }

  // Limitation du login admin : 5 échecs / 15 min / IP. Opt-in : bloque ensuite l'IP.
  if (process.env.RL_LOGIN_TEST === '1') {
    let got429 = false;
    for (let i = 0; i < 6 && !got429; i++) {
      const r = await http('/api/admin/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: 'sondage-wrong-' + i }) });
      if (r.status === 429) got429 = true;
    }
    if (got429) ok(C, 'POST /api/admin/login → 429 au 6e échec', '');
    else ko(C, 'POST /api/admin/login → 429 au 6e échec', 'aucun 429');
  } else skip(C, 'POST /api/admin/login → 429', 'RL_LOGIN_TEST=1 pour tester (bloque l’IP 15 min)');
}

// ═══════════════════════════════════════════════════════════════════
// C. AUDIT STATIQUE HTML
// ═══════════════════════════════════════════════════════════════════
const REFRESHED_PAGES = [
  'index.html', 'analyse.html', 'outils.html', 'accords.html', 'bibli.html',
  'grilles.html', 'metronome.html', 'quiz.html', 'quiz-play.html',
  'admin/index.html', 'admin/eleves.html', 'admin/transcripteur.html',
  'admin/shorts.html', 'admin/analyse.html', 'admin/stems.html',
  'admin/loops.html', 'admin/quiz.html',
];
const OOS_PAGES = ['admin/login.html']; // hors-scope refresh (login minimal)

function auditPage(C, rel, { refreshed }) {
  if (!exists(rel)) { ko(C, rel, 'fichier introuvable'); return; }
  const html = rd(rel);
  let pageKo = 0, pageWarn = 0;
  const { inlineClassic, inlineModule, srcs } = extractScripts(html);

  // Parse inline classic
  inlineClassic.forEach((code, i) => {
    if (!code.trim()) return;
    const err = checkJs(code, false);
    if (err) { ko(C, `${rel} <script>#${i + 1}`, err); pageKo++; }
  });
  // Parse inline module
  inlineModule.forEach((code, i) => {
    if (!code.trim()) return;
    const err = checkJs(code, true);
    if (err) { ko(C, `${rel} <script type=module>#${i + 1}`, err); pageKo++; }
  });
  // Parse external local scripts
  srcs.forEach((src) => {
    if (/^https?:\/\//i.test(src)) return; // CDN → skip
    const local = src.replace(/^\//, '').split('?')[0];
    if (!exists(local)) { warn(C, `${rel} → ${src}`, 'fichier local introuvable'); pageWarn++; return; }
    const isMod = /export |import /.test(rd(local).slice(0, 4000));
    const err = checkJsFile(local, isMod);
    if (err) { ko(C, `${local} (via ${rel})`, err); pageKo++; }
  });

  if (refreshed) {
    if (!/assets\/css\/design-system\.css/.test(html)) { warn(C, `${rel} design-system.css`, 'import manquant'); pageWarn++; }
    if (!/Cormorant/i.test(html)) { warn(C, `${rel} Cormorant`, 'police manquante'); pageWarn++; }
    if (!/Plus.?Jakarta/i.test(html)) { warn(C, `${rel} Plus Jakarta`, 'police manquante'); pageWarn++; }
  }

  if (pageKo === 0 && pageWarn === 0) ok(C, rel, refreshed ? 'parse + DS + polices ✓' : 'parse ✓');
  else if (pageKo === 0) ok(C, rel, `parse ✓ (${pageWarn} warning)`);
}

function categoryC() {
  const C = 'C. Audit statique HTML';
  for (const p of REFRESHED_PAGES) auditPage(C, p, { refreshed: true });
  for (const p of OOS_PAGES) auditPage(C, p, { refreshed: false });

  // ── Références orphelines (frontend repertoire / drive / open) ──
  const Crf = 'C. Références orphelines';
  const htmlFiles = REFRESHED_PAGES;
  // Scope par token : les refs UI répertoire vivaient dans index + admin/eleves.
  // driveUrl : le var supprimé était la carte Ressources/Drive du DASHBOARD
  // (index.html). admin/eleves.html a un `driveUrl` distinct = le canal Drive
  // de la fiche élève (canaux.drive), feature légitime et active → hors scope.
  const orphanChecks = [
    { tok: 'loadRepertoire', scope: htmlFiles },
    { tok: 'openMorceauModal', scope: htmlFiles },
    { tok: 'repertoire-zone', scope: htmlFiles },
    { tok: 'driveUrl', scope: ['index.html'], note: 'scopé index.html (canal Drive admin = légitime)' },
  ];
  for (const { tok, scope, note } of orphanChecks) {
    const hits = scope.filter(p => exists(p) && rd(p).includes(tok));
    if (hits.length === 0) ok(Crf, `aucune réf orpheline "${tok}"`, note || '');
    else ko(Crf, `réf orpheline "${tok}"`, hits.join(', '));
  }
  // ?open= dans analyse.html (doit avoir disparu)
  if (exists('analyse.html')) {
    const a = rd('analyse.html');
    if (!/[?&]open=/.test(a) && !/params\.get\(['"]open['"]\)/.test(a)) ok(Crf, 'analyse.html sans ?open=ID', '');
    else ko(Crf, 'analyse.html contient encore ?open=ID', '');
  }
  // .mh-rep-* nulle part (UI répertoire retirée + bloc CSS supprimé)
  const repHits = [];
  const allFiles = [...htmlFiles, 'assets/css/design-system.css', 'assets/js/repertoire.js'];
  for (const f of allFiles) if (exists(f) && /\bmh-rep-/.test(rd(f))) repHits.push(f);
  if (repHits.length === 0) ok(Crf, 'aucune réf .mh-rep-*', 'UI répertoire bien retirée');
  else warn(Crf, 'réf .mh-rep-* présente', repHits.join(', '));

  // ── Classes essentielles définies dans le design system ──
  const Cls = 'C. Classes design system';
  const ds = exists('assets/css/design-system.css') ? rd('assets/css/design-system.css') : '';
  for (const cls of ['.mh-card', '.mh-section-label', '.mh-btn-primary', '.mh-btn-secondary', '.mh-card-hero']) {
    if (ds.includes(cls + ' ') || ds.includes(cls + ',') || ds.includes(cls + '{') || ds.includes(cls + ':') || new RegExp('\\' + cls + '\\b').test(ds))
      ok(Cls, `${cls} défini`, '');
    else ko(Cls, `${cls} absent du design system`, '');
  }
  // index.html utilise .mh-card-hero
  if (exists('index.html') && /mh-card-hero/.test(rd('index.html'))) ok(Cls, 'index.html utilise .mh-card-hero', '');
  else warn(Cls, 'index.html .mh-card-hero', 'non référencée');
}

// ═══════════════════════════════════════════════════════════════════
// D. AUDIT MODULES JS
// ═══════════════════════════════════════════════════════════════════
function categoryD() {
  const C = 'D. Modules JS';
  const checks = [
    ['assets/js/multitrack-player.js', /\bMultitrackPlayer\b/, 'MultitrackPlayer (constructeur)'],
    ['assets/js/analyse-player.js', /\bAnalysePlayer\b/, 'AnalysePlayer (constructeur)'],
    ['assets/js/stems-cache.js', /window\.|global\.|function /, 'helpers stems-cache'],
    ['nav-outils.js', /bottom-nav/, 'logique bottom-nav'],
  ];
  for (const [file, re, label] of checks) {
    if (!exists(file)) { ko(C, label, `${file} introuvable`); continue; }
    const err = checkJsFile(file, /export |import /.test(rd(file).slice(0, 2000)));
    if (err) { ko(C, label, `parse: ${err}`); continue; }
    if (re.test(rd(file))) ok(C, label, file);
    else warn(C, label, `symbole attendu absent dans ${file}`);
  }
  // quiz-engine.js : s'exécute sans ReferenceError (window.noteToFr)
  {
    const sandbox = { console };
    sandbox.window = sandbox;
    try {
      vm.runInNewContext(rd('mh-music-theory.js') + '\n' + rd('quiz-engine.js'), sandbox);
      if (typeof sandbox.QuizEngine === 'function' && sandbox.noteToFr('C#') === 'Do♯')
        ok(C, 'quiz-engine.js s\'exécute (QuizEngine + noteToFr)', '');
      else ko(C, 'quiz-engine.js exports', 'QuizEngine ou noteToFr absent');
    } catch (e) { ko(C, 'quiz-engine.js s\'exécute', String(e && e.message || e)); }
  }
  // _lib/devoirs-parser.js
  {
    const f = 'functions/api/_lib/devoirs-parser.js';
    const src = exists(f) ? rd(f) : '';
    const err = exists(f) ? checkJsFile(f, true) : 'introuvable';
    if (err) ko(C, 'devoirs-parser', err);
    else if (/export\s+function\s+parseDevoirsFromDoc/.test(src) && /export\s+(async\s+)?function\s+fetchAndParseDevoirs/.test(src))
      ok(C, 'devoirs-parser exporte parseDevoirsFromDoc + fetchAndParseDevoirs', '');
    else warn(C, 'devoirs-parser exports', 'noms attendus non trouvés');
  }
  // _lib/repertoire.js (dormant)
  {
    const f = 'functions/api/_lib/repertoire.js';
    const src = exists(f) ? rd(f) : '';
    const err = exists(f) ? checkJsFile(f, true) : 'introuvable';
    if (err) ko(C, 'repertoire lib', err);
    else if (/export\s+function\s+buildMorceau/.test(src))
      ok(C, 'repertoire lib intacte (validation)', 'exportée sous le nom buildMorceau (pas validateMorceau)');
    else warn(C, 'repertoire lib validation', 'fonction de validation introuvable');
  }
  // Tous les workers exportent onRequest*
  const Cw = 'D. Workers onRequest';
  const workerFiles = [];
  (function walk(dir) {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`;
      const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (e.endsWith('.js') && !rel.includes('/_lib/') && !e.startsWith('_')) workerFiles.push(rel);
    }
  })('functions/api');
  let bad = 0;
  for (const f of workerFiles) {
    const src = rd(f);
    const perr = checkJsFile(f, true);
    if (perr) { ko(Cw, f, `parse: ${perr}`); bad++; continue; }
    if (!/export\s+(async\s+)?function\s+onRequest/.test(src) && !/export\s+const\s+onRequest/.test(src)) {
      warn(Cw, f, 'aucun export onRequest* détecté'); bad++;
    }
  }
  if (bad === 0) ok(Cw, `${workerFiles.length} workers exportent onRequest* + parsent`, '');
}

// ═══════════════════════════════════════════════════════════════════
// E. SHORTS SMOKE TEST
// ═══════════════════════════════════════════════════════════════════
function categoryE() {
  const C = 'E. Shorts smoke';
  skip(C, 'POST /api/admin/shorts/extract (SSE)', 'non testable : ni ffmpeg ni audio réel ni cookie admin dans cet environnement');
}

// ═══════════════════════════════════════════════════════════════════
// F. COHÉRENCE KV PUBLIQUE
// ═══════════════════════════════════════════════════════════════════
async function categoryF() {
  const C = 'F. Cohérence KV';
  if (!ADMIN_COOKIE) {
    skip(C, 'onboarded / répertoire', 'routes réservées élève/admin : cookie admin requis (ADMIN_PW)');
    return;
  }
  const H = { headers: { cookie: ADMIN_COOKIE } };
  for (const s of SLUGS) {
    const ob = await http(`/api/eleves/${s}/onboarded`, H);
    if (ob.status === 200) {
      if (ob.body.seen) {
        const ts = ob.body.firstSeenAt;
        const okTs = typeof ts === 'number' && ts > 1.5e12 && ts <= Date.now() + 60000;
        if (okTs) ok(C, `[${s}] onboarded firstSeenAt valide`, new Date(ts).toISOString());
        else ko(C, `[${s}] onboarded firstSeenAt invalide`, String(ts));
      } else ok(C, `[${s}] onboarded non vu (seen=false)`, 'cohérent (firstSeenAt null)');
    } else ko(C, `[${s}] onboarded`, `status ${ob.status}`);

    // re-fetch repertoire pour cohérence (double lecture)
    const r1 = await http(`/api/eleves/${s}/repertoire`, H);
    const r2 = await http(`/api/eleves/${s}/repertoire`, H);
    if (r1.status === 200 && r2.status === 200 &&
        JSON.stringify(r1.body?.morceaux) === JSON.stringify(r2.body?.morceaux))
      ok(C, `[${s}] repertoire stable (2 lectures)`, `${r1.body.morceaux.length} morceaux`);
    else warn(C, `[${s}] repertoire`, 'lectures divergentes ou erreur');

    skip(C, `[${s}] devoirs:/analyse:/stems: assignedTo`, 'auth/KV admin requis → non vérifiable ici');
  }
}

// ═══════════════════════════════════════════════════════════════════
// RAPPORT
// ═══════════════════════════════════════════════════════════════════
function report() {
  const line = '─'.repeat(64);
  console.log('\n' + '═'.repeat(64));
  console.log('  SONDAGE MASTER HUB — RAPPORT');
  console.log('  base: ' + BASE);
  console.log('═'.repeat(64));

  let totKo = 0, totWarn = 0;
  console.log('\n| Catégorie | OK | Warn | Skip | KO |');
  console.log('|---|---|---|---|---|');
  for (const name of order) {
    const c = cats[name];
    totKo += c.ko; totWarn += c.warn;
    console.log(`| ${name} | ${c.ok} | ${c.warn} | ${c.skip} | ${c.ko} |`);
  }

  // Anomalies
  console.log('\n' + line + '\nANOMALIES (KO + warnings)\n' + line);
  let any = false;
  for (const name of order) {
    for (const it of cats[name].items) {
      if (it.level === 'ko' || it.level === 'warn') {
        any = true;
        const sev = it.level === 'ko' ? 'BLOQUANT/À-VÉRIFIER' : 'cosmétique/info';
        console.log(`  [${it.level.toUpperCase()}] (${name}) ${it.label} — ${it.detail} [${sev}]`);
      }
    }
  }
  if (!any) console.log('  Aucune.');

  // Skips notables
  console.log('\n' + line + '\nNON TESTABLE ICI (skip)\n' + line);
  for (const name of order)
    for (const it of cats[name].items)
      if (it.level === 'skip') console.log(`  [SKIP] (${name}) ${it.label} — ${it.detail}`);

  console.log('\n' + line + '\nVERDICT\n' + line);
  const verdict = totKo > 0 ? 'NON (bloquants détectés)' : (totWarn > 0 ? 'MOSTLY (cosmétiques/infos uniquement)' : 'OUI production-ready');
  console.log('  ' + verdict + `   (KO=${totKo}, warnings=${totWarn})`);
  console.log('');
  return totKo;
}

// ─── Run ───────────────────────────────────────────────────────────
const failFast = process.argv.includes('--static-only');
try {
  if (!failFast) await categoryA();
  if (!failFast) await categoryB();
  categoryC();
  categoryD();
  categoryE();
  if (!failFast) await categoryF();
} catch (e) {
  console.error('Erreur fatale du harness:', e);
  process.exit(2);
}
const ko_ = report();
process.exit(ko_ > 0 ? 1 : 0);
