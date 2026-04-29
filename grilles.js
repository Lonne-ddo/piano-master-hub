// ─── Master Hub — Grilles harmoniques (logique principale) ─────────
// Module IIFE (closure, aucune globale exportée).
// Phase 1 : sélection des types d'accords + tempo → POST /api/grilles/generate
// Phase 2 : 5 cartes progression avec lecture audio block (1 accord = 1 mesure
// de 4 temps au tempo choisi).

(function () {
    'use strict';

    if (!window.MhTheory) {
        console.error('[grilles] MhTheory non chargé');
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
        console.warn('[grilles] slug invalide → redirect /');
        window.location.replace('/');
        return;
    }
    try { localStorage.setItem('eleve_slug', slug); } catch (e) {}

    var STORAGE_KEY = 'mh_grilles:' + slug;
    var DEFAULT_STATE = {
        selectedTypes: [],
        tempo: 80,
        notation: 'fr'
    };

    function loadPersisted() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return Object.assign({}, DEFAULT_STATE);
            return Object.assign({}, DEFAULT_STATE, JSON.parse(raw));
        } catch (e) {
            return Object.assign({}, DEFAULT_STATE);
        }
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                selectedTypes: state.selectedTypes,
                tempo: state.tempo,
                notation: state.notation
            }));
        } catch (e) {}
    }

    // ═══ State ═══
    var persisted = loadPersisted();
    var state = {
        phase: 'selection',
        selectedTypes: persisted.selectedTypes.slice(),
        tempo: clampTempo(persisted.tempo),
        notation: persisted.notation || 'fr',
        progressions: [],
        currentlyPlaying: null,
        currentChordIndex: 0,
        playbackTimers: [],
        loading: false
    };

    function clampTempo(v) {
        var n = parseInt(v, 10);
        if (isNaN(n)) return 80;
        return Math.max(60, Math.min(140, n));
    }

    // ═══ Catalogues ═══
    var TYPE_FAMILIES = [
        { label: 'Triades',    types: ['maj','min','dim','aug','sus2','sus4'] },
        { label: 'Septièmes',  types: ['7','maj7','min7','min7b5','dim7','mMaj7'] },
        { label: 'Sixtes',     types: ['6','min6'] },
        { label: 'Extensions', types: ['9','13','min11','add9'] },
        { label: 'Altérées',   types: ['7sus4','7b9','7#5','7#9'] }
    ];

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

    // ═══ Sampler (lazy-init, pattern accords/quiz) ═══
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

    // ═══ Volume slider ═══
    function applyVolume(pct) {
        if (typeof Tone === 'undefined' || !Tone.Destination) return;
        Tone.Destination.volume.value = pct <= 0 ? -Infinity : 20 * Math.log10(pct / 100);
    }
    function initVolumeSlider() {
        var slider = $('volume-slider');
        var label = $('volume-value');
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

    // ═══ Normalisation chord names (LLM utilise notation standard m7,
    // MhTheory veut min7) ═══
    function normalizeChord(name) {
        var n = String(name).trim();
        // Alias unicode
        n = n.replace(/\u00F87?/g, 'min7b5');   // ø, ø7
        n = n.replace(/\u0394/g, 'maj');        // Δ → maj (Δ7 → maj7 via ordering)
        n = n.replace(/^([A-G][#b]?)maj7/, '$1maj7'); // no-op placeholder
        // Ordre : suffixes longs d'abord
        n = n.replace(/^([A-G][#b]?)mMaj7/i, '$1mMaj7');
        n = n.replace(/^([A-G][#b]?)m7b5\b/, '$1min7b5');
        n = n.replace(/^([A-G][#b]?)m11\b/,  '$1min11');
        n = n.replace(/^([A-G][#b]?)m7\b/,   '$1min7');
        n = n.replace(/^([A-G][#b]?)m6\b/,   '$1min6');
        // m alone = mineur (mais pas si suivi de "aj" ou "Maj")
        n = n.replace(/^([A-G][#b]?)m(?![A-Za-z0-9#b])/, '$1min');
        return n;
    }

    // Récupère les notes (avec octave 4) pour un nom d'accord LLM.
    // Fallback : si non parsable, retourne la triade majeure de la racine.
    function chordToNotes(chordName) {
        var normalized = normalizeChord(chordName);
        var parsed = MT.parseChord(normalized);
        if (parsed) {
            try {
                return MT.buildChord(parsed.root + '4', parsed.type);
            } catch (e) {}
        }
        // Fallback : tente d'extraire la racine
        var m = String(chordName).match(/^([A-G][#b]?)/);
        if (m) {
            try { return MT.buildChord(m[1] + '4', 'maj'); } catch (e) {}
        }
        return [];
    }

    // ═══ Audio playback ═══
    function clearTimers() {
        for (var i = 0; i < state.playbackTimers.length; i++) clearTimeout(state.playbackTimers[i]);
        state.playbackTimers = [];
    }

    // Stop avec fade-out 150ms (anti-pop).
    // Note : on NE restaure PAS le volume à 0 dB après fade — ça réveillerait
    // les notes encore en phase de release. Le volume reste à -Infinity et sera
    // restauré au prochain playProgression() (cancelScheduledValues + value=0).
    var FADE_MS = 150;
    function stopAllPlayback(opts) {
        opts = opts || {};
        clearTimers();
        state.currentlyPlaying = null;
        state.currentChordIndex = 0;

        if (sampler) {
            if (opts.immediate) {
                try { sampler.releaseAll(); } catch (e) {}
                try {
                    if (sampler.volume.cancelScheduledValues) {
                        sampler.volume.cancelScheduledValues(Tone.now());
                    }
                    sampler.volume.value = 0;
                } catch (e) {}
            } else {
                try { sampler.volume.rampTo(-Infinity, FADE_MS / 1000); } catch (e) {}
                setTimeout(function () {
                    try { sampler.releaseAll(); } catch (e) {}
                }, FADE_MS + 20);
            }
        }
        // Différer le re-render pour que le bouton reste "■ Stop" pendant le fade,
        // puis bascule en "▶ Jouer" une fois le fade terminé.
        setTimeout(function () { renderResults(); }, opts.immediate ? 0 : FADE_MS + 10);
    }

    // Lecture récursive : chaque accord programme le suivant via setTimeout en
    // RELISANT state.tempo à chaque itération. Permet le tempo live.
    function playProgression(idx) {
        if (state.currentlyPlaying === idx) {
            stopAllPlayback();
            return;
        }
        if (state.currentlyPlaying !== null) {
            // Switch vers une autre progression : stop immédiat (sans fade) pour
            // démarrer la nouvelle dans la foulée.
            clearTimers();
            state.currentlyPlaying = null;
            if (sampler) { try { sampler.releaseAll(); } catch (e) {} }
        }

        var prog = state.progressions[idx];
        if (!prog) return;

        ensureAudio().then(function () {
            if (!sampler) return;
            // Restaure le volume au cas où un fade-out précédent l'aurait laissé bas
            try {
                if (sampler.volume.cancelScheduledValues) {
                    sampler.volume.cancelScheduledValues(Tone.now());
                }
                sampler.volume.value = 0;
            } catch (e) {}

            state.currentlyPlaying = idx;
            state.currentChordIndex = 0;
            renderResults();

            playNext(idx, prog);
        }).catch(function (err) {
            console.warn('[grilles] audio fail', err);
            showToast('Erreur audio : ' + (err.message || 'sampler'));
            state.currentlyPlaying = null;
            state.currentChordIndex = 0;
            renderResults();
        });
    }

    function playNext(idx, prog) {
        if (state.currentlyPlaying !== idx) return; // stop entre-temps
        if (state.currentChordIndex >= prog.chords.length) {
            state.currentlyPlaying = null;
            state.currentChordIndex = 0;
            state.playbackTimers = [];
            renderResults();
            return;
        }

        var chordIdx = state.currentChordIndex;
        var chordName = prog.chords[chordIdx];
        var notes = chordToNotes(chordName);
        var beatSec = 60 / state.tempo;        // RELU à chaque itération
        var measureSec = beatSec * 4;          // 1 accord = 1 mesure 4 temps
        var releaseRatio = 0.95;               // mini-gap entre mesures

        setActiveChip(idx, chordIdx);
        if (notes.length && sampler) {
            try {
                sampler.triggerAttackRelease(notes, measureSec * releaseRatio);
            } catch (e) {}
        }

        var t = setTimeout(function () {
            state.currentChordIndex++;
            playNext(idx, prog);
        }, measureSec * 1000);
        state.playbackTimers.push(t);
    }

    function setActiveChip(progIdx, chordIdx) {
        // Reset tous les chips de cette progression, puis active celui en cours
        var card = document.querySelector('[data-prog-idx="' + progIdx + '"]');
        if (!card) return;
        var chips = card.querySelectorAll('.chord-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active', i === chordIdx);
        }
    }

    // ═══ API call ═══
    function generate() {
        if (state.selectedTypes.length === 0) return;
        if (state.loading) return;

        state.loading = true;
        renderSelection();

        fetch('/api/grilles/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ types: state.selectedTypes })
        }).then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        }).then(function (r) {
            state.loading = false;
            if (!r.ok || !r.data || !r.data.ok) {
                var err = (r.data && r.data.error) || 'erreur inconnue';
                showToast('Génération échouée : ' + err);
                renderSelection();
                return;
            }
            state.progressions = r.data.progressions || [];
            state.phase = 'results';
            stopAllPlayback({ immediate: true });
            renderAll();
        }).catch(function (e) {
            state.loading = false;
            console.error('[grilles] generate failed:', e);
            showToast('Erreur réseau : ' + (e.message || ''));
            renderSelection();
        });
    }

    // ═══ Rendu UI ═══
    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function renderAll() {
        if (state.phase === 'selection') renderSelection();
        else                              renderResults();
    }

    function renderSelection() {
        var sub = $('page-subtitle');
        if (sub) sub.textContent = 'Choisis les types à travailler';

        var counter = state.selectedTypes.length;
        var counterText = counter === 0
            ? '<span>Aucun type sélectionné</span>'
            : '<strong>' + counter + '</strong> type' + (counter > 1 ? 's' : '') + ' sélectionné' + (counter > 1 ? 's' : '');

        var html = '<div class="selection-card">';
        html +=     '<div class="types-counter">' + counterText + '</div>';

        // Familles de types
        html += '<div class="ctrl-section">';
        html +=     '<div class="section-label">Types d\'accords</div>';
        html +=     '<div class="type-families" id="type-families">';
        TYPE_FAMILIES.forEach(function (fam) {
            html += '<div class="family-group">';
            html +=     '<div class="family-label">' + escapeHtml(fam.label) + '</div>';
            html +=     '<div class="type-grid">';
            fam.types.forEach(function (t) {
                var def = MT.CHORD_TYPES[t];
                if (!def) return;
                var checked = state.selectedTypes.indexOf(t) >= 0 ? ' checked' : '';
                var suffix = TYPE_SUFFIX[t];
                var displayId = (suffix === '' || suffix === undefined) ? 'maj' : suffix;
                html += '<button type="button" class="type-btn' + checked +
                        '" data-type="' + escapeHtml(t) + '" title="' + escapeHtml(def.name) + '">' +
                            '<span class="type-id">' + escapeHtml(displayId) + '</span>' +
                            '<span class="type-name">' + escapeHtml(def.name) + '</span>' +
                        '</button>';
            });
            html +=     '</div></div>';
        });
        html +=     '</div>';
        html += '</div>';

        // Tempo slider
        html += '<div class="ctrl-section">';
        html +=     '<div class="section-label">Tempo</div>';
        html +=     '<div class="tempo-row">';
        html +=         '<span class="tempo-label">60</span>';
        html +=         '<input type="range" id="tempo-slider" min="60" max="140" step="2" value="' + state.tempo + '" />';
        html +=         '<span class="tempo-value"><span id="tempo-value">' + state.tempo + '</span> BPM</span>';
        html +=     '</div>';
        html += '</div>';

        // Generate button
        var disabled = (state.selectedTypes.length === 0 || state.loading) ? 'disabled' : '';
        var loadingClass = state.loading ? ' loading' : '';
        var btnLabel = state.loading ? '⏳ Génération en cours…' : '🎲 Générer 5 progressions';
        html += '<button type="button" class="btn-generate' + loadingClass +
                '" id="btn-generate" ' + disabled + '>' + btnLabel + '</button>';

        html += '</div>'; // selection-card

        $('main-area').innerHTML = html;

        // Wire events (post-render)
        var families = $('type-families');
        if (families) {
            families.addEventListener('click', function (e) {
                var btn = e.target.closest('button[data-type]');
                if (!btn) return;
                var t = btn.getAttribute('data-type');
                var idx = state.selectedTypes.indexOf(t);
                if (idx >= 0) state.selectedTypes.splice(idx, 1);
                else          state.selectedTypes.push(t);
                persist();
                renderSelection();
            });
        }

        var tempoSlider = $('tempo-slider');
        var tempoValue = $('tempo-value');
        if (tempoSlider && tempoValue) {
            tempoSlider.addEventListener('input', function () {
                state.tempo = clampTempo(tempoSlider.value);
                tempoValue.textContent = state.tempo;
                persist();
            });
        }

        var btnGen = $('btn-generate');
        if (btnGen) btnGen.addEventListener('click', generate);
    }

    function renderResults() {
        var sub = $('page-subtitle');
        if (sub) sub.textContent = (DISPLAY[slug] || slug) + ' · ' + state.progressions.length + ' progressions';

        // Tempo bar sticky en haut de la phase résultats
        var html = '<div class="tempo-bar">';
        html +=     '<span class="tempo-label">Tempo</span>';
        html +=     '<input type="range" id="tempo-slider-results" min="60" max="140" step="1" value="' + state.tempo + '" aria-label="Tempo" />';
        html +=     '<span class="tempo-value" id="tempo-value-results">' + state.tempo + ' BPM</span>';
        html += '</div>';

        html += '<div class="results-head">';
        html +=     '<div class="section-label">5 progressions pour toi</div>';
        html +=     '<button type="button" class="btn-modify" id="btn-modify">← Modifier ma sélection</button>';
        html += '</div>';

        html += '<div class="progressions-grid">';
        state.progressions.forEach(function (prog, i) {
            var keyDisplay = prog.key_label_fr || prog.key || '';
            var isPlaying = (state.currentlyPlaying === i);
            html += '<div class="progression-card' + (isPlaying ? ' is-playing' : '') +
                    '" data-prog-idx="' + i + '">';
            html +=     '<div class="progression-key">' + escapeHtml(keyDisplay) + '</div>';
            html +=     '<div class="progression-chords">';
            prog.chords.forEach(function (chordName, j) {
                var deg = (prog.degrees && prog.degrees[j]) ? prog.degrees[j] : '';
                html += '<div class="chord-chip" data-chord-idx="' + j + '">';
                html +=     '<span class="chord-name">' + escapeHtml(chordName) + '</span>';
                html +=     '<span class="chord-degree">' + escapeHtml(deg) + '</span>';
                html += '</div>';
            });
            html +=     '</div>';
            html +=     '<div class="progression-actions">';
            var btnLabel = isPlaying ? '■ Stop' : '▶ Jouer la grille';
            var btnClass = isPlaying ? 'btn-play-prog is-playing' : 'btn-play-prog';
            // Pas de disabled : on peut switcher entre progressions, le code stop l'en cours
            html +=         '<button type="button" class="' + btnClass + '" data-play="' + i + '">' +
                                escapeHtml(btnLabel) + '</button>';
            html +=     '</div>';
            html += '</div>';
        });
        html += '</div>';

        $('main-area').innerHTML = html;

        // Wire events
        var btnMod = $('btn-modify');
        if (btnMod) btnMod.addEventListener('click', function () {
            stopAllPlayback({ immediate: true });
            state.phase = 'selection';
            state.progressions = [];
            renderAll();
        });

        var grid = document.querySelector('.progressions-grid');
        if (grid) {
            grid.addEventListener('click', function (e) {
                var btn = e.target.closest('button[data-play]');
                if (!btn) return;
                var idx = parseInt(btn.getAttribute('data-play'), 10);
                if (isNaN(idx)) return;
                playProgression(idx);
            });
        }

        // Tempo slider live : si une progression joue, le changement s'applique
        // à l'accord suivant (le récursif playNext relit state.tempo à chaque
        // itération). L'accord en cours finit à son tempo initial.
        var tSlider = $('tempo-slider-results');
        var tValue  = $('tempo-value-results');
        if (tSlider && tValue) {
            tSlider.addEventListener('input', function () {
                state.tempo = clampTempo(tSlider.value);
                tValue.textContent = state.tempo + ' BPM';
                persist();
            });
        }
    }

    // ═══ Toast ═══
    var toastTimer = null;
    function showToast(msg) {
        var toast = $('toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('is-visible');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('is-visible');
        }, 3500);
    }

    // ═══ Cleanup ═══
    function cleanup() {
        clearTimers();
        try { if (sampler) { sampler.releaseAll(); sampler.dispose(); } } catch (e) {}
        sampler = null;
        persist();
    }
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // ═══ Init ═══
    function init() {
        var back = $('back-link');
        if (back) back.href = '/outils?eleve=' + encodeURIComponent(slug);
        initVolumeSlider();
        renderAll();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
