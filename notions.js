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

// ─── Démarrage ─────────────────────────────────────────────────────
function notionsStart() {
    notionsLoadJson('/data/notions.json')
        .then(function (index) {
            notionsIndex = index;
            notionsRenderLibrary();
        })
        .catch(function () {
            notionsShowMessage('Impossible de charger les notions. Vérifie ta connexion puis recharge la page.');
        });
}

window.requireValidEleve(notionsSlug).then(function (ok) {
    if (ok) notionsStart();
});
