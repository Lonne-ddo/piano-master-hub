// ─── Master Hub — Dictionnaire d'accords (logique principale) ──────
// Module IIFE (closure, aucune globale exportée).
// Consomme window.MhTheory pour la théorie ; charge un Tone.Sampler
// nbrosowsky en lazy-init ; persiste l'état par élève dans localStorage.

(async function () {
    'use strict';

    if (!window.MhTheory) {
        console.error('[accords] MhTheory non chargé');
        return;
    }
    var MT = window.MhTheory;

    // ═══ Slug + persistance ═══
    // Whitelist déléguée à /api/eleves via assets/js/eleve-guard.js (avec
    // fallback hardcodé). Permet aux nouveaux élèves créés par l'admin
    // d'accéder sans patcher ce fichier.
    var params = new URLSearchParams(window.location.search);
    var slugRaw = params.get('eleve');
    var slug = slugRaw ? slugRaw.toLowerCase() : null;
    if (!(await window.requireValidEleve(slug))) return;
    try { localStorage.setItem('eleve_slug', slug); } catch (e) {}

    var STORAGE_KEY = 'mh_accords:' + slug;
    var DEFAULT_STATE = {
        root: 'C',
        type: 'maj',
        inversion: 0,
        octave: 4,
        notation: 'FR'
    };

    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return Object.assign({}, DEFAULT_STATE);
            var parsed = JSON.parse(raw);
            return Object.assign({}, DEFAULT_STATE, parsed);
        } catch (e) {
            return Object.assign({}, DEFAULT_STATE);
        }
    }

    function persistState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
    }

    var state = loadState();

    // Bornes octave (échantillons dispo C2..C5)
    var OCT_MIN = 2;
    var OCT_MAX = 5;
    if (state.octave < OCT_MIN) state.octave = OCT_MIN;
    if (state.octave > OCT_MAX) state.octave = OCT_MAX;

    // ═══ Catalogues d'affichage ═══
    // Mapping id type → suffixe d'affichage (notation jazz)
    var TYPE_SUFFIX = {
        'maj':    '',       'min':    'm',
        'dim':    '\u00B0', 'aug':    '+',
        'sus2':   'sus2',   'sus4':   'sus4',
        '7':      '7',      'maj7':   'maj7',
        'min7':   'm7',     'min7b5': 'm7\u266D5',
        'dim7':   '\u00B07','mMaj7':  'mMaj7',
        '6':      '6',      'min6':   'm6',
        'add9':   'add9',   '9':      '9',
        '13':     '13',     'min11':  'm11',
        '7sus4':  '7sus4',  '7b9':    '7\u266D9',
        '7#5':    '7\u266F5','7#9':   '7\u266F9'
    };

    // Familles d'accords pour rendu groupé dans le bottom sheet
    var TYPE_FAMILIES = [
        { label: 'Triades',    types: ['maj','min','dim','aug','sus2','sus4'] },
        { label: 'Septièmes',  types: ['7','maj7','min7','min7b5','dim7','mMaj7'] },
        { label: 'Sixtes',     types: ['6','min6'] },
        { label: 'Extensions', types: ['9','13','min11','add9'] },
        { label: 'Altérées',   types: ['7sus4','7b9','7#5','7#9'] }
    ];

    // ═══ Helpers musicaux ═══

    function transposeNoteUpOctave(noteWithOct) {
        return MT.getUpperNote(noteWithOct, 12);
    }

    function getMaxInversion() {
        var def = MT.CHORD_TYPES[state.type];
        if (!def) return 0;
        return Math.min(3, def.intervals.length - 1);
    }

    function applyInversion(notes, inv) {
        if (!inv) return notes.slice();
        var arr = notes.slice();
        for (var i = 0; i < inv && i < arr.length; i++) {
            arr[i] = transposeNoteUpOctave(arr[i]);
        }
        arr.sort(function (a, b) {
            return noteToMidi(a) - noteToMidi(b);
        });
        return arr;
    }

    function noteToMidi(n) {
        var m = String(n).match(/^([A-G][#b]?)(\d+)$/);
        if (!m) return 0;
        var name = MT.toSharp(m[1]);
        var oct = parseInt(m[2], 10);
        var idx = MT.CHROMATIC_SHARP.indexOf(name);
        return (oct + 1) * 12 + idx;
    }

    function getCurrentChordNotes() {
        var rootStr = state.root + state.octave;
        var notes;
        try {
            notes = MT.buildChord(rootStr, state.type);
        } catch (e) {
            notes = MT.buildChord(rootStr, 'maj');
        }
        return applyInversion(notes, state.inversion);
    }

    function getChordName() {
        return state.root + (TYPE_SUFFIX[state.type] || '');
    }

    function noteDisplay(noteWithOctave) {
        var m = String(noteWithOctave).match(/^([A-G][#b]?)(\d+)?$/);
        var base = m ? m[1] : noteWithOctave;
        if (state.notation === 'FR') return MT.noteToFr(base);
        return base;
    }

    // ═══ Sampler (lazy-init, pattern quiz-engine) ═══

    var sampler = null;
    var samplerLoadingPromise = null;

    function initSampler() {
        if (samplerLoadingPromise) return samplerLoadingPromise;
        samplerLoadingPromise = new Promise(function (resolve, reject) {
            sampler = new Tone.Sampler({
                urls: {
                    'A1': 'A1.mp3', 'A2': 'A2.mp3', 'A3': 'A3.mp3', 'A4': 'A4.mp3',
                    'C2': 'C2.mp3', 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3',
                    'D#2': 'Ds2.mp3', 'D#3': 'Ds3.mp3', 'D#4': 'Ds4.mp3',
                    'F#2': 'Fs2.mp3', 'F#3': 'Fs3.mp3', 'F#4': 'Fs4.mp3'
                },
                release: 1.5,
                baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/piano/',
                onload: resolve,
                onerror: reject
            }).toDestination();
        });
        return samplerLoadingPromise;
    }

    function ensureAudio() {
        var p = (Tone.context.state !== 'running') ? Tone.start() : Promise.resolve();
        return p.then(initSampler);
    }

    // ═══ Volume slider (cohérent quiz-play) ═══

    function applyVolume(pct) {
        if (typeof Tone === 'undefined' || !Tone.Destination) return;
        Tone.Destination.volume.value = pct <= 0 ? -Infinity : 20 * Math.log10(pct / 100);
    }

    function initVolumeSlider() {
        var slider = document.getElementById('volume-slider');
        var label = document.getElementById('volume-value');
        if (!slider || !label) return;
        var saved = parseFloat(localStorage.getItem('masterhub_volume'));
        var pct = isNaN(saved) ? 70 : Math.max(0, Math.min(100, saved));
        slider.value = pct;
        label.textContent = pct + '%';
        applyVolume(pct);
        slider.addEventListener('input', function () {
            var v = parseFloat(slider.value);
            label.textContent = Math.round(v) + '%';
            applyVolume(v);
            try { localStorage.setItem('masterhub_volume', String(v)); } catch (e) {}
        });
    }

    // ═══ Audio actions ═══

    var arpeggioTimers = [];

    function clearArpeggio() {
        for (var i = 0; i < arpeggioTimers.length; i++) clearTimeout(arpeggioTimers[i]);
        arpeggioTimers = [];
    }

    function playChord() {
        clearArpeggio();
        ensureAudio().then(function () {
            if (!sampler) return;
            try { sampler.releaseAll(); } catch (e) {}
            var notes = getCurrentChordNotes();
            sampler.triggerAttackRelease(notes, '2n');
        }).catch(function (err) {
            console.warn('[accords] audio fail', err);
        });
    }

    function playArpeggio() {
        clearArpeggio();
        ensureAudio().then(function () {
            if (!sampler) return;
            try { sampler.releaseAll(); } catch (e) {}
            var notes = getCurrentChordNotes();
            var step = 280; // ms entre notes
            notes.forEach(function (n, i) {
                var t = setTimeout(function () {
                    if (sampler) sampler.triggerAttackRelease(n, '2n');
                }, i * step);
                arpeggioTimers.push(t);
            });
        }).catch(function (err) {
            console.warn('[accords] audio fail', err);
        });
    }

    // ═══ Rendu UI ═══

    function $(id) { return document.getElementById(id); }

    function renderInfoSection() {
        var notes = getCurrentChordNotes();
        var def = MT.CHORD_TYPES[state.type];

        $('chord-name').textContent = getChordName();

        var notesText = notes.map(noteDisplay).join(' · ');
        $('chord-notes').textContent = notesText;

        // Intervalles toujours affichés en ordre canonique (1, 3, 5, …) :
        // ils décrivent la structure de l'accord, pas la voicing après renversement.
        var ivLabels = (def && def.ivLabels) ? def.ivLabels : [];
        $('chord-intervals').textContent = ivLabels.length ? ivLabels.join(' · ') : '—';

        $('notation-fr').classList.toggle('active', state.notation === 'FR');
        $('notation-en').classList.toggle('active', state.notation === 'EN');
    }

    // ─ Clavier SVG adaptatif ─
    // 1 octave = viewBox 700×500 (ratio 7/5 — touche blanche 1:5, proportions
    // piano standard). 2 octaves = 1400×500. Pas de min/max-height en CSS :
    // le ratio viewBox + width:100% gèrent la hauteur naturellement.

    var WHITE_PER_OCT = ['C','D','E','F','G','A','B'];
    var BLACK_OFFSETS = [
        { name: 'C#', x: 70  },
        { name: 'D#', x: 170 },
        { name: 'F#', x: 370 },
        { name: 'G#', x: 470 },
        { name: 'A#', x: 570 }
    ];

    function renderKeyboard() {
        var notes = getCurrentChordNotes();
        var midis = notes.map(noteToMidi);
        var minMidi = Math.min.apply(null, midis);
        var maxMidi = Math.max.apply(null, midis);
        var startOct = Math.floor(minMidi / 12) - 1;
        // Toutes les notes appartiennent à des octaves dans [startOct, ...]
        var endOct = Math.floor(maxMidi / 12) - 1;
        var octCount = Math.max(1, Math.min(3, endOct - startOct + 1));

        // Set des "name+octave" en convention sharp pour highlight
        var hl = {};
        notes.forEach(function (n) {
            var m = String(n).match(/^([A-G][#b]?)(\d+)$/);
            if (!m) return;
            var name = MT.toSharp(m[1]);
            hl[name + m[2]] = true;
        });

        var WW = 100, WH = 500, BW = 60, BH = 300;
        var totalW = octCount * 7 * WW;
        var svg = $('chord-keyboard');
        svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + WH);

        var parts = [];
        // Couches : blanches d'abord, puis noires par-dessus
        for (var o = 0; o < octCount; o++) {
            var oct = startOct + o;
            for (var w = 0; w < 7; w++) {
                var name = WHITE_PER_OCT[w];
                var key = name + oct;
                var x = (o * 7 + w) * WW;
                var fill = hl[key] ? '#a48ff0' : '#f5f5f5';
                var stroke = hl[key] ? '#8B6FE8' : '#222';
                parts.push(
                    '<rect x="' + x + '" y="0" width="' + WW + '" height="' + WH +
                    '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="5" rx="7"/>'
                );
                if (hl[key]) {
                    parts.push(
                        '<circle cx="' + (x + WW/2) + '" cy="' + (WH - 75) +
                        '" r="26" fill="#fff" opacity="0.85"/>'
                    );
                }
            }
        }
        for (var o2 = 0; o2 < octCount; o2++) {
            var oct2 = startOct + o2;
            for (var b = 0; b < BLACK_OFFSETS.length; b++) {
                var bk = BLACK_OFFSETS[b];
                var keyB = bk.name + oct2;
                var xB = (o2 * 7 * WW) + bk.x;
                var fillB = hl[keyB] ? '#7a5dd6' : '#1a1a24';
                var strokeB = hl[keyB] ? '#a48ff0' : '#000';
                parts.push(
                    '<rect x="' + xB + '" y="0" width="' + BW + '" height="' + BH +
                    '" fill="' + fillB + '" stroke="' + strokeB + '" stroke-width="4" rx="5"/>'
                );
                if (hl[keyB]) {
                    parts.push(
                        '<circle cx="' + (xB + BW/2) + '" cy="' + (BH - 60) +
                        '" r="22" fill="#fff" opacity="0.85"/>'
                    );
                }
            }
        }
        svg.innerHTML = parts.join('');
    }

    // Tonique : 2 lignes (blanches + bémols décalés pour aligner sur les blanches).
    // state.root est stocké en convention sharp (canonique). Les boutons "Réb"
    // envoient la version sharp équivalente via data-root.
    function renderRootGrid() {
        var grid = $('root-grid');
        var whites = ['C','D','E','F','G','A','B'];
        // 6 cellules entre les 2 spacers ; null = pas de bémol entre Mi et Fa.
        var flats  = ['Db','Eb', null, 'Gb','Ab','Bb'];

        var html = '<div class="root-row whites">';
        whites.forEach(function (n) {
            var sel = (n === state.root) ? ' selected' : '';
            var label = (state.notation === 'FR') ? MT.noteToFr(n) : n;
            html += '<button type="button" class="root-btn' + sel +
                '" data-root="' + n + '">' + label + '</button>';
        });
        html += '</div>';

        html += '<div class="root-row flats">';
        html += '<div class="root-spacer"></div>';
        flats.forEach(function (n) {
            if (n === null) {
                html += '<div class="root-spacer"></div>';
                return;
            }
            var sharp = MT.toSharp(n);
            var sel = (sharp === state.root) ? ' selected' : '';
            var label = (state.notation === 'FR')
                ? MT.noteToFr(n, { useFlat: true })
                : n;
            html += '<button type="button" class="root-btn flat-btn' + sel +
                '" data-root="' + sharp + '">' + label + '</button>';
        });
        html += '<div class="root-spacer"></div>';
        html += '</div>';

        grid.innerHTML = html;
    }

    function renderTypeFamilies() {
        var container = $('type-families');
        var html = '';
        TYPE_FAMILIES.forEach(function (fam) {
            html += '<div class="family-group">';
            html += '<div class="family-label">' + fam.label + '</div>';
            html += '<div class="type-grid">';
            fam.types.forEach(function (t) {
                var def = MT.CHORD_TYPES[t];
                if (!def) return;
                var sel = (t === state.type) ? ' selected' : '';
                var suffix = TYPE_SUFFIX[t];
                var displayId = (suffix === '' || suffix === undefined) ? 'maj' : suffix;
                html +=
                    '<button type="button" class="type-btn' + sel +
                    '" data-type="' + t + '" title="' + def.name + '">' +
                        '<span class="type-id">' + displayId + '</span>' +
                        '<span class="type-name">' + def.name + '</span>' +
                    '</button>';
            });
            html += '</div></div>';
        });
        container.innerHTML = html;
    }

    var INV_LABELS = ['Fond.', '1\u02E2\u1D49', '2\u1D49', '3\u1D49'];
    function renderInvGrid() {
        var grid = $('inv-grid');
        var max = getMaxInversion();
        var html = '';
        for (var i = 0; i <= 3; i++) {
            var disabled = (i > max) ? ' disabled' : '';
            var sel = (i === state.inversion) ? ' selected' : '';
            html += '<button type="button" class="chip' + sel + disabled +
                '" data-inv="' + i + '"' + (disabled ? ' aria-disabled="true"' : '') +
                '>' + INV_LABELS[i] + '</button>';
        }
        grid.innerHTML = html;
    }

    function renderOctave() {
        $('oct-display').textContent = String(state.octave);
        $('oct-down').classList.toggle('disabled', state.octave <= OCT_MIN);
        $('oct-up').classList.toggle('disabled', state.octave >= OCT_MAX);
    }

    function renderAll() {
        renderInfoSection();
        renderKeyboard();
        renderRootGrid();
        renderTypeFamilies();
        renderInvGrid();
        renderOctave();
        persistState();
    }

    // ═══ Bottom sheet (mobile) ═══
    // Le panel `.controls-panel` est sticky-sidebar en desktop ; sur mobile il
    // se transforme en bottom sheet caché par défaut (transform translateY(100%)).
    // Ouverture via "⚙ Choisir l'accord", fermeture via backdrop / ✓ Valider /
    // drag-down sur le handle.

    function openSheet() {
        var sheet = $('controls-panel');
        var bd    = $('sheet-backdrop');
        if (!sheet || !bd) return;
        sheet.classList.add('is-open');
        bd.classList.add('is-visible');
        document.body.style.overflow = 'hidden';
    }

    function closeSheet() {
        var sheet = $('controls-panel');
        var bd    = $('sheet-backdrop');
        if (!sheet || !bd) return;
        sheet.classList.remove('is-open');
        bd.classList.remove('is-visible');
        document.body.style.overflow = '';
    }

    // ═══ Event listeners ═══

    function bindEvents() {
        $('btn-play').addEventListener('click', playChord);
        $('btn-arpeggio').addEventListener('click', playArpeggio);

        $('notation-fr').addEventListener('click', function () {
            if (state.notation !== 'FR') {
                state.notation = 'FR';
                renderAll();
            }
        });
        $('notation-en').addEventListener('click', function () {
            if (state.notation !== 'EN') {
                state.notation = 'EN';
                renderAll();
            }
        });

        $('root-grid').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-root]');
            if (!btn) return;
            state.root = btn.getAttribute('data-root');
            renderAll();
        });

        $('type-families').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-type]');
            if (!btn) return;
            state.type = btn.getAttribute('data-type');
            var max = getMaxInversion();
            if (state.inversion > max) state.inversion = max;
            renderAll();
        });

        $('inv-grid').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-inv]');
            if (!btn || btn.classList.contains('disabled')) return;
            var inv = parseInt(btn.getAttribute('data-inv'), 10);
            if (isNaN(inv)) return;
            if (inv > getMaxInversion()) return;
            state.inversion = inv;
            renderAll();
        });

        $('oct-down').addEventListener('click', function () {
            if (state.octave > OCT_MIN) {
                state.octave--;
                renderAll();
            }
        });
        $('oct-up').addEventListener('click', function () {
            if (state.octave < OCT_MAX) {
                state.octave++;
                renderAll();
            }
        });

        var back = $('back-link');
        if (back) back.href = '/outils?eleve=' + encodeURIComponent(slug);

        var sub = $('page-subtitle');
        if (sub) sub.textContent = (DISPLAY[slug] || slug) + ' · 22 types · renversements';

        // ─ Bottom sheet (mobile) ─
        var btnOpen = $('btn-open-sheet');
        var btnVal  = $('btn-validate-sheet');
        var bd      = $('sheet-backdrop');
        var sheet   = $('controls-panel');
        if (btnOpen) btnOpen.addEventListener('click', openSheet);
        if (btnVal)  btnVal.addEventListener('click', closeSheet);
        if (bd)      bd.addEventListener('click', closeSheet);

        // Drag-down to close : déclenché si touch démarre dans les 30 premiers
        // pixels du sheet (zone du handle), seuil de fermeture à 80px.
        if (sheet) {
            var touchStartY = null;
            sheet.addEventListener('touchstart', function (e) {
                var rect = sheet.getBoundingClientRect();
                if (e.touches[0].clientY - rect.top < 30) {
                    touchStartY = e.touches[0].clientY;
                }
            }, { passive: true });
            sheet.addEventListener('touchmove', function (e) {
                if (touchStartY === null) return;
                var dy = e.touches[0].clientY - touchStartY;
                if (dy > 80) {
                    closeSheet();
                    touchStartY = null;
                }
            }, { passive: true });
            sheet.addEventListener('touchend', function () {
                touchStartY = null;
            });
            sheet.addEventListener('touchcancel', function () {
                touchStartY = null;
            });
        }
    }

    // ═══ Cleanup ═══

    function cleanup() {
        clearArpeggio();
        try { if (sampler) { sampler.releaseAll(); sampler.dispose(); } } catch (e) {}
        sampler = null;
        persistState();
    }
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // ═══ Init ═══

    function init() {
        initVolumeSlider();
        bindEvents();
        renderAll();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
