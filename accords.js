// ─── Master Hub — Dictionnaire d'accords (logique principale) ──────
// Module IIFE (closure, aucune globale exportée).
// Consomme window.MhTheory pour la théorie ; charge un Tone.Sampler
// nbrosowsky en lazy-init ; persiste l'état par élève dans localStorage.

(function () {
    'use strict';

    if (!window.MhTheory) {
        console.error('[accords] MhTheory non chargé');
        return;
    }
    var MT = window.MhTheory;

    // ═══ Slug + persistance ═══
    var ELEVES = ['japhet', 'tara', 'dexter', 'messon'];
    var DISPLAY = { japhet: 'Japhet', tara: 'Tara', dexter: 'Dexter', messon: 'Messon' };

    var params = new URLSearchParams(window.location.search);
    var slugRaw = params.get('eleve');
    var slug = slugRaw ? slugRaw.toLowerCase() : null;
    if (!slug || ELEVES.indexOf(slug) < 0) {
        console.warn('[accords] slug invalide → redirect /');
        window.location.replace('/');
        return;
    }
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
    var ROOT_LIST = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    var TYPE_LIST = Object.keys(MT.CHORD_TYPES);

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
    // 1 octave = viewBox 700×110, 7 touches blanches × 100, noires × 60
    // Si l'accord déborde l'octave courante, on étend à 2 octaves (1400×110).

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

        var WW = 100, WH = 110, BW = 60, BH = 65;
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
                    '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2" rx="3"/>'
                );
                if (hl[key]) {
                    parts.push(
                        '<circle cx="' + (x + WW/2) + '" cy="' + (WH - 18) +
                        '" r="6" fill="#fff" opacity="0.85"/>'
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
                    '" fill="' + fillB + '" stroke="' + strokeB + '" stroke-width="1.5" rx="2"/>'
                );
                if (hl[keyB]) {
                    parts.push(
                        '<circle cx="' + (xB + BW/2) + '" cy="' + (BH - 14) +
                        '" r="5" fill="#fff" opacity="0.85"/>'
                    );
                }
            }
        }
        svg.innerHTML = parts.join('');
    }

    function renderRootGrid() {
        var grid = $('root-grid');
        var html = '';
        ROOT_LIST.forEach(function (r) {
            var sel = (r === state.root) ? ' selected' : '';
            var label = (state.notation === 'FR') ? MT.noteToFr(r) : r;
            html += '<button type="button" class="pill' + sel + '" data-root="' + r + '">' + label + '</button>';
        });
        grid.innerHTML = html;
    }

    function renderTypeGrid() {
        var grid = $('type-grid');
        var html = '';
        TYPE_LIST.forEach(function (t) {
            var def = MT.CHORD_TYPES[t];
            var sel = (t === state.type) ? ' selected' : '';
            var suffix = TYPE_SUFFIX[t] || t;
            var displayId = suffix === '' ? 'maj' : suffix;
            html +=
                '<button type="button" class="pill type-pill' + sel + '" data-type="' + t + '" title="' + def.name + '">' +
                    '<span class="type-id">' + displayId + '</span>' +
                    '<span class="type-name">' + def.name + '</span>' +
                '</button>';
        });
        grid.innerHTML = html;
    }

    var INV_LABELS = ['Fond.', '1\u02E2\u1D49', '2\u1D49', '3\u1D49'];
    function renderInvGrid() {
        var grid = $('inv-grid');
        var max = getMaxInversion();
        var html = '';
        for (var i = 0; i <= 3; i++) {
            var disabled = (i > max) ? ' disabled' : '';
            var sel = (i === state.inversion) ? ' selected' : '';
            html += '<button type="button" class="pill' + sel + disabled +
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
        renderTypeGrid();
        renderInvGrid();
        renderOctave();
        persistState();
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

        $('type-grid').addEventListener('click', function (e) {
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
