// ─── Notions : bibliothèque + fiches thématiques (lecture seule) ────
// Une seule page, routage par query string :
//   /notions?eleve=slug              → bibliothèque
//   /notions?eleve=slug&fiche=<id>   → fiche
// Données statiques : /data/notions.json et /data/fiches/<id>.json.
// Progression locale (localStorage) : notions:<slug>:last et
// notions:<slug>:done:<id>. Aucun appel en écriture vers l'API.

var notionsParams = new URLSearchParams(window.location.search);
var notionsSlug = (notionsParams.get('eleve') || '').toLowerCase().trim();
var notionsFicheId = (notionsParams.get('fiche') || '').trim();
var notionsApp = document.getElementById('app');
var notionsIndex = null;
var notionsLib = { query: '', family: 'all', resume: null };

var NOTIONS_ICONS = {
    back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>',
    search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A6A3B8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>',
    searchBig: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6E6A84" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>',
    play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#FFFFFF" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>',
    chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>'
};

// ─── Utilitaires ───────────────────────────────────────────────────
function notionsEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Insensible à la casse, aux accents et au type d'apostrophe
function notionsNormalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
}

function notionsStoreGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function notionsStoreSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* stockage indisponible */ }
}

function notionsLibraryUrl() {
    return '/notions?eleve=' + encodeURIComponent(notionsSlug);
}
function notionsFicheUrl(id) {
    return notionsLibraryUrl() + '&fiche=' + encodeURIComponent(id);
}

function notionsFindNotion(id) {
    var list = (notionsIndex && notionsIndex.notions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
}
function notionsFindFamily(id) {
    var list = (notionsIndex && notionsIndex.families) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
}

// Étapes d'exercice visibles (status ok), avec leur index d'origine
function notionsVisibleSteps(fiche) {
    var out = [];
    (fiche.exercise || []).forEach(function (s, i) {
        if (s.status === 'ok') out.push({ index: i, text: s.text });
    });
    return out;
}

function notionsDoneKey(id) {
    return 'notions:' + notionsSlug + ':done:' + id;
}
function notionsReadDone(id) {
    var raw = notionsStoreGet(notionsDoneKey(id));
    if (!raw) return [];
    try {
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(function (n) { return typeof n === 'number'; }) : [];
    } catch (e) { return []; }
}

function notionsStepsLabel(done, total) {
    return 'Exercice : ' + done + (done > 1 ? ' étapes' : ' étape') + ' sur ' + total;
}

function notionsLoadJson(url) {
    return fetch(url, { credentials: 'same-origin' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
}

function notionsShowMessage(text) {
    notionsApp.removeAttribute('aria-busy');
    notionsApp.innerHTML = '<p class="page-msg" role="alert">' + notionsEscape(text) + '</p>';
}

// ─── Bibliothèque ──────────────────────────────────────────────────
function notionsRenderLibrary() {
    var total = notionsIndex.notions.length;
    var chips = [{ id: 'all', label: 'Toutes' }].concat(notionsIndex.families.map(function (f) {
        return { id: f.id, label: f.short };
    }));

    notionsApp.innerHTML =
        '<header class="lib-head">' +
            '<div class="lib-title-row fu">' +
                '<a class="icon-btn press" href="/?eleve=' + encodeURIComponent(notionsSlug) + '" aria-label="Retour à l\'accueil">' + NOTIONS_ICONS.back + '</a>' +
                '<div class="lib-title">' +
                    '<span class="kicker">Piano Master</span>' +
                    '<h1>Mes notions</h1>' +
                '</div>' +
                '<span class="lib-count" id="lib-count" aria-live="polite">' + total + ' notions</span>' +
            '</div>' +
            '<label class="search fu d1">' +
                NOTIONS_ICONS.search +
                '<span class="sr-only">Rechercher une notion</span>' +
                '<input type="search" id="lib-search" autocomplete="off" enterkeyhint="search" placeholder="Rechercher : renversement, triton, gamme…">' +
            '</label>' +
            '<div class="chips fu d2" role="group" aria-label="Filtrer par famille">' +
                chips.map(function (c) {
                    return '<button type="button" class="chip press" data-family="' + notionsEscape(c.id) + '" aria-pressed="' + (c.id === notionsLib.family ? 'true' : 'false') + '">' + notionsEscape(c.label) + '</button>';
                }).join('') +
            '</div>' +
        '</header>' +
        '<div class="lib-list" id="lib-list"></div>';
    notionsApp.removeAttribute('aria-busy');

    var input = document.getElementById('lib-search');
    input.value = notionsLib.query;
    input.addEventListener('input', function () {
        notionsLib.query = input.value;
        notionsRenderList(false);
    });

    Array.prototype.forEach.call(notionsApp.querySelectorAll('.chip'), function (btn) {
        btn.addEventListener('click', function () {
            notionsLib.family = btn.getAttribute('data-family');
            notionsSyncChips();
            notionsRenderList(false);
        });
    });

    notionsRenderList(true);
    notionsLoadResume();
}

function notionsSyncChips() {
    Array.prototype.forEach.call(notionsApp.querySelectorAll('.chip'), function (btn) {
        btn.setAttribute('aria-pressed', btn.getAttribute('data-family') === notionsLib.family ? 'true' : 'false');
    });
}

function notionsResetFilters() {
    notionsLib.query = '';
    notionsLib.family = 'all';
    var input = document.getElementById('lib-search');
    if (input) input.value = '';
    notionsSyncChips();
    notionsRenderList(false);
    if (input) input.focus();
}

function notionsRenderList(firstRender) {
    var list = document.getElementById('lib-list');
    if (!list) return;
    var q = notionsNormalize(notionsLib.query.trim());
    var fam = notionsLib.family;
    var familyNames = {};
    notionsIndex.families.forEach(function (f) { familyNames[f.id] = notionsNormalize(f.name + ' ' + f.short); });

    var hits = notionsIndex.notions.filter(function (n) {
        if (fam !== 'all' && n.family !== fam) return false;
        if (!q) return true;
        return notionsNormalize(n.name).indexOf(q) !== -1 || (familyNames[n.family] || '').indexOf(q) !== -1;
    });
    var filtered = !!q || fam !== 'all';
    var total = notionsIndex.notions.length;

    var count = document.getElementById('lib-count');
    if (count) count.textContent = filtered ? hits.length + ' / ' + total : total + ' notions';

    var html = '';
    if (!filtered && notionsLib.resume) html += notionsLib.resume;

    var groupIndex = 0;
    notionsIndex.families.forEach(function (f) {
        var items = hits.filter(function (n) { return n.family === f.id; });
        if (!items.length) return;
        var anim = firstRender ? ' fu" style="animation-delay:' + (120 + groupIndex * 60) + 'ms' : '';
        groupIndex++;
        html +=
            '<section class="group' + anim + '" aria-labelledby="g-' + f.id + '">' +
                '<div class="group-head">' +
                    '<h2 id="g-' + f.id + '">' + notionsEscape(f.name) + '</h2>' +
                    '<span class="group-count">' + items.length + (items.length > 1 ? ' notions' : ' notion') + '</span>' +
                '</div>' +
                '<ul class="group-list">' +
                    items.map(notionsRowHtml).join('') +
                '</ul>' +
            '</section>';
    });

    if (!hits.length) {
        html +=
            '<div class="empty">' +
                NOTIONS_ICONS.searchBig +
                '<span class="empty-title">Aucune notion trouvée</span>' +
                '<span class="empty-text">Essaie un autre mot ou retire un filtre.</span>' +
                '<button type="button" class="btn-ghost press" id="lib-reset">Tout afficher</button>' +
            '</div>';
    }

    list.innerHTML = html;
    var reset = document.getElementById('lib-reset');
    if (reset) reset.addEventListener('click', notionsResetFilters);
}

function notionsRowHtml(n) {
    if (n.fiche) {
        return '<li><a class="row" href="' + notionsEscape(notionsFicheUrl(n.id)) + '">' +
            '<span class="row-body">' +
                '<span class="row-name">' + notionsEscape(n.name) + '</span>' +
                '<span class="row-ready">Fiche disponible</span>' +
            '</span>' +
            '<span style="color:var(--n-violet-text);display:flex">' + NOTIONS_ICONS.chevron + '</span>' +
        '</a></li>';
    }
    return '<li><div class="row row-soon">' +
        '<span class="row-body"><span class="row-name">' + notionsEscape(n.name) + '</span></span>' +
        '<span class="soon-badge">Bientôt</span>' +
    '</div></li>';
}

// Carte « Reprendre » : dernière fiche ouverte + progression de l'exercice
function notionsLoadResume() {
    var lastId = notionsStoreGet('notions:' + notionsSlug + ':last');
    var notion = lastId ? notionsFindNotion(lastId) : null;
    if (!notion || !notion.fiche) return;
    notionsLoadJson('/data/fiches/' + encodeURIComponent(notion.id) + '.json')
        .then(function (fiche) {
            var steps = notionsVisibleSteps(fiche);
            var done = notionsReadDone(fiche.id);
            var doneCount = steps.filter(function (s) { return done.indexOf(s.index) !== -1; }).length;
            notionsLib.resume =
                '<a class="resume press fu d3" href="' + notionsEscape(notionsFicheUrl(fiche.id)) + '">' +
                    '<span class="resume-icon">' + NOTIONS_ICONS.play + '</span>' +
                    '<span class="resume-body">' +
                        '<span class="resume-kicker">Reprendre</span>' +
                        '<span class="resume-title">' + notionsEscape(fiche.title) + '</span>' +
                        '<span class="resume-progress">' + notionsStepsLabel(doneCount, steps.length) + '</span>' +
                    '</span>' +
                    '<span style="color:var(--n-text-3);display:flex">' + NOTIONS_ICONS.chevron + '</span>' +
                '</a>';
            var list = document.getElementById('lib-list');
            var filtered = !!notionsLib.query.trim() || notionsLib.family !== 'all';
            if (list && !filtered) list.insertAdjacentHTML('afterbegin', notionsLib.resume);
        })
        .catch(function () { /* pas de carte Reprendre */ });
}

// ─── Clavier (un seul moteur pour toutes les fiches) ───────────────
var NOTIONS_PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
var NOTIONS_WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];

// "Eb4" → { midi: 63, name: "Eb" }
function notionsParseNote(note) {
    var m = /^([A-G])(#|b)?(\d)$/.exec(String(note));
    if (!m) return null;
    var midi = (Number(m[3]) + 1) * 12 + NOTIONS_PITCH[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return { midi: midi, name: m[1] + (m[2] || '') };
}

// Touches de la plage : blanches côte à côte, noires à cheval sur la jointure
function notionsKeyboardHtml(range) {
    var lo = notionsParseNote(range[0]);
    var hi = notionsParseNote(range[1]);
    if (!lo || !hi) return { html: '', dense: false };
    var whites = [];
    var blacks = [];
    for (var m = lo.midi; m <= hi.midi; m++) {
        if (NOTIONS_WHITE_PCS.indexOf(m % 12) !== -1) whites.push(m);
        else if (whites.length) blacks.push({ midi: m, after: whites.length - 1 });
    }
    var w = 100 / whites.length;
    var bw = w * 0.63;
    var html = '';
    whites.forEach(function (midi, i) {
        html += '<div class="key key-white" data-midi="' + midi + '" style="left:' + (i * w) + '%;width:calc(' + w + '% - 1px)">' +
            '<span class="key-fill"></span><span class="key-label"></span></div>';
    });
    blacks.forEach(function (b) {
        html += '<div class="key key-black" data-midi="' + b.midi + '" style="left:' + ((b.after + 1) * w - bw / 2 - 0.15) + '%;width:' + bw + '%">' +
            '<span class="key-fill"></span><span class="key-label"></span></div>';
    });
    return { html: html, dense: whites.length > 10 };
}

function notionsKeyboardSelect(kb, index) {
    var opt = kb.options[index];
    var lit = {};
    var names = [];
    opt.notes.forEach(function (n) {
        var p = notionsParseNote(n);
        if (!p) return;
        lit[p.midi] = p.name;
        names.push(p.name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.kb .key'), function (key) {
        var midi = key.getAttribute('data-midi');
        var on = Object.prototype.hasOwnProperty.call(lit, midi);
        key.classList.toggle('is-on', on);
        if (on) key.querySelector('.key-label').textContent = lit[midi];
    });
    Array.prototype.forEach.call(document.querySelectorAll('.kb-options button'), function (btn, i) {
        btn.setAttribute('aria-pressed', i === index ? 'true' : 'false');
    });
    var board = document.getElementById('kb');
    if (board) board.setAttribute('aria-label', 'Clavier : ' + (opt.aria || opt.label) + ', notes ' + names.join(' '));
    var caption = document.getElementById('kb-caption');
    if (caption) caption.textContent = opt.caption || '';
}

// ─── Fiche ─────────────────────────────────────────────────────────
var NOTIONS_FICHE_ICONS = {
    avoid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F2A8A0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16.5v.5"></path></svg>',
    timer: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2"></path><path d="M9 2h6"></path></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>'
};

// Astuce affichée : la version ok (la principale, sinon une variante ok)
function notionsTipText(tip) {
    if (tip.status === 'ok') return tip.text;
    var variants = tip.variants || [];
    for (var i = 0; i < variants.length; i++) if (variants[i].status === 'ok') return variants[i].text;
    return null;
}

function notionsRenderFiche(fiche) {
    var family = notionsFindFamily(fiche.family);
    var kb = fiche.keyboard;
    var board = notionsKeyboardHtml(kb.range);
    var hasSub = kb.options.some(function (o) { return !!o.sub; });
    var hasCaption = kb.options.some(function (o) { return !!o.caption; });
    var tips = (fiche.tips || []).map(notionsTipText).filter(Boolean);
    var steps = notionsVisibleSteps(fiche);
    var done = notionsReadDone(fiche.id);

    var related = (fiche.related || []).map(function (id) {
        var n = notionsFindNotion(id);
        if (!n) return '';
        if (n.fiche) return '<a href="' + notionsEscape(notionsFicheUrl(n.id)) + '">' + notionsEscape(n.name) + '</a>';
        return '<span aria-disabled="true" title="Fiche bientôt disponible">' + notionsEscape(n.name) + '</span>';
    }).join('');

    document.title = 'Master Hub — ' + fiche.title;
    notionsApp.innerHTML =
        '<article class="fiche">' +
            '<div class="fiche-scroll">' +
                '<header class="fiche-head fu">' +
                    '<a class="icon-btn press" href="' + notionsEscape(notionsLibraryUrl()) + '" aria-label="Retour à la bibliothèque">' + NOTIONS_ICONS.back + '</a>' +
                    '<div class="fiche-head-text">' +
                        '<span class="kicker">' + notionsEscape(family ? family.name : '') + '</span>' +
                        '<h1>' + notionsEscape(fiche.title) + '</h1>' +
                    '</div>' +
                '</header>' +
                '<p class="fiche-summary fu d1">' + notionsEscape(fiche.summary) + '</p>' +
                '<div class="kb-block fu d2">' +
                    '<div class="kb-options' + (hasSub ? ' has-sub' : '') + '" role="group" aria-label="' + notionsEscape(kb.groupLabel || 'Choisir sur le clavier') + '" style="grid-template-columns:repeat(' + kb.options.length + ',minmax(0,1fr))">' +
                        kb.options.map(function (o, i) {
                            return '<button type="button" class="press" data-opt="' + i + '" aria-pressed="false"' + (o.aria ? ' aria-label="' + notionsEscape(o.aria) + '"' : '') + '>' +
                                '<span class="kb-opt-main">' + notionsEscape(o.label) + '</span>' +
                                (o.sub ? '<span class="kb-opt-sub">' + notionsEscape(o.sub) + '</span>' : '') +
                            '</button>';
                        }).join('') +
                    '</div>' +
                    '<div class="kb' + (board.dense ? ' is-dense' : '') + '" id="kb" role="img">' + board.html + '</div>' +
                    (hasCaption ? '<p class="kb-caption" id="kb-caption" aria-live="polite"></p>' : '') +
                '</div>' +
                '<section class="essentials fu d3" aria-labelledby="ess-title">' +
                    '<h2 class="section-label" id="ess-title" style="margin:0;font-weight:400">L\'essentiel</h2>' +
                    (fiche.essentials || []).map(function (e) {
                        return '<p>' + e.parts.map(function (p) {
                            return '<strong>' + notionsEscape(p.term) + '</strong> · ' + notionsEscape(p.text);
                        }).join(' ') + '</p>';
                    }).join('') +
                '</section>' +
                (tips.length ?
                    '<section class="tips fu d4" aria-labelledby="tips-title">' +
                        '<div class="tips-head"><span class="tips-avatar" aria-hidden="true">L</span><h2 id="tips-title">Les astuces de Lonne</h2></div>' +
                        tips.map(function (t) { return '<p>« ' + notionsEscape(t) + ' »</p>'; }).join('') +
                    '</section>' : '') +
                '<div class="avoid fu d5">' + NOTIONS_FICHE_ICONS.avoid +
                    '<p><strong>À éviter</strong> · ' + notionsEscape(fiche.avoid) + '</p>' +
                '</div>' +
            '</div>' +
            '<div class="fiche-foot">' +
                '<button type="button" class="btn-primary press fu d6" id="ex-open" aria-haspopup="dialog" aria-controls="ex-sheet">' +
                    NOTIONS_FICHE_ICONS.timer + 'Exercice · 5 min' +
                '</button>' +
            '</div>' +
        '</article>' +
        '<div class="backdrop" id="ex-backdrop" hidden></div>' +
        '<div class="sheet" id="ex-sheet" role="dialog" aria-modal="true" aria-labelledby="ex-title" hidden>' +
            '<div class="sheet-handle" aria-hidden="true"></div>' +
            '<div class="sheet-head">' +
                '<h2 id="ex-title">Exercice · 5 min</h2>' +
                '<button type="button" class="icon-btn" id="ex-close" aria-label="Fermer">' + NOTIONS_FICHE_ICONS.close + '</button>' +
            '</div>' +
            '<ul class="steps">' +
                steps.map(function (s) {
                    var d = done.indexOf(s.index) !== -1;
                    return '<li><button type="button" class="step press" data-step="' + s.index + '" aria-pressed="' + (d ? 'true' : 'false') + '">' +
                        '<span class="step-box" aria-hidden="true">' + (d ? '✓' : '') + '</span>' +
                        '<span class="step-text">' + notionsEscape(s.text) + '</span>' +
                    '</button></li>';
                }).join('') +
            '</ul>' +
            (related ?
                '<div class="related-block">' +
                    '<span class="kicker">Notions liées</span>' +
                    '<div class="related">' + related + '</div>' +
                '</div>' : '') +
        '</div>';
    notionsApp.removeAttribute('aria-busy');

    Array.prototype.forEach.call(notionsApp.querySelectorAll('.kb-options button'), function (btn) {
        btn.addEventListener('click', function () {
            notionsKeyboardSelect(kb, Number(btn.getAttribute('data-opt')));
        });
    });
    notionsKeyboardSelect(kb, 0);

    Array.prototype.forEach.call(notionsApp.querySelectorAll('.step'), function (btn) {
        btn.addEventListener('click', function () { notionsToggleStep(fiche.id, btn); });
    });

    document.getElementById('ex-open').addEventListener('click', notionsOpenSheet);
    document.getElementById('ex-close').addEventListener('click', notionsCloseSheet);
    document.getElementById('ex-backdrop').addEventListener('click', notionsCloseSheet);
    document.addEventListener('keydown', notionsSheetKeys);
}

function notionsToggleStep(ficheId, btn) {
    var index = Number(btn.getAttribute('data-step'));
    var done = notionsReadDone(ficheId);
    var pos = done.indexOf(index);
    var box = btn.querySelector('.step-box');
    if (pos === -1) {
        done.push(index);
        btn.setAttribute('aria-pressed', 'true');
        box.textContent = '✓';
        box.classList.remove('pop');
        void box.offsetWidth; // relance l'animation
        box.classList.add('pop');
    } else {
        done.splice(pos, 1);
        btn.setAttribute('aria-pressed', 'false');
        box.textContent = '';
        box.classList.remove('pop');
    }
    done.sort(function (a, b) { return a - b; });
    notionsStoreSet(notionsDoneKey(ficheId), JSON.stringify(done));
}

function notionsSheetOpen() {
    var sheet = document.getElementById('ex-sheet');
    return !!sheet && !sheet.hidden;
}

function notionsOpenSheet() {
    document.getElementById('ex-backdrop').hidden = false;
    document.getElementById('ex-sheet').hidden = false;
    document.querySelector('.fiche').setAttribute('aria-hidden', 'true');
    document.getElementById('ex-close').focus();
}

function notionsCloseSheet() {
    if (!notionsSheetOpen()) return;
    document.getElementById('ex-backdrop').hidden = true;
    document.getElementById('ex-sheet').hidden = true;
    document.querySelector('.fiche').removeAttribute('aria-hidden');
    document.getElementById('ex-open').focus();
}

// Échap ferme ; Tab reste dans le panneau tant qu'il est ouvert
function notionsSheetKeys(e) {
    if (!notionsSheetOpen()) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        notionsCloseSheet();
        return;
    }
    if (e.key !== 'Tab') return;
    var focusables = document.getElementById('ex-sheet').querySelectorAll('button, a[href]');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function notionsOpenFiche(id) {
    var notion = notionsFindNotion(id);
    if (!notion || !notion.fiche) {
        window.location.replace(notionsLibraryUrl());
        return;
    }
    notionsLoadJson('/data/fiches/' + encodeURIComponent(id) + '.json')
        .then(function (fiche) {
            if (!fiche || fiche.id !== id || !fiche.keyboard) throw new Error('fiche invalide');
            notionsStoreSet('notions:' + notionsSlug + ':last', id);
            notionsRenderFiche(fiche);
        })
        .catch(function () {
            notionsShowMessage('Impossible de charger cette fiche. Vérifie ta connexion puis recharge la page.');
        });
}

// ─── Démarrage ─────────────────────────────────────────────────────
function notionsStart() {
    notionsLoadJson('/data/notions.json')
        .then(function (index) {
            notionsIndex = index;
            if (notionsFicheId) notionsOpenFiche(notionsFicheId);
            else notionsRenderLibrary();
        })
        .catch(function () {
            notionsShowMessage('Impossible de charger les notions. Vérifie ta connexion puis recharge la page.');
        });
}

window.requireValidEleve(notionsSlug).then(function (ok) {
    if (ok) notionsStart();
});
