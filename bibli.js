// ─── Master Hub — Bibliothèque musicale (logique principale) ──────
// Module IIFE (closure, aucune globale exportée).
// Phase 1 : recherche (titre, artiste, genre, niveau) → POST /api/bibli/generate
// Phase 2 : rendu paroles + accords ChordPro alignés en monospace, avec
// transpose, slider tempo, lecture audio block enchaînée.

(function () {
    'use strict';

    if (!window.MhTheory) {
        console.error('[bibli] MhTheory non chargé');
        return;
    }
    var MT = window.MhTheory;

    // ═══ Slug + persistance ═══
    var ELEVES = ['japhet', 'tara', 'dexter', 'messon'];

    var params = new URLSearchParams(window.location.search);
    var slugRaw = params.get('eleve');
    var slug = slugRaw ? slugRaw.toLowerCase() : null;
    if (!slug || ELEVES.indexOf(slug) < 0) {
        console.warn('[bibli] slug invalide → redirect /');
        window.location.replace('/');
        return;
    }
    try { localStorage.setItem('eleve_slug', slug); } catch (e) {}

    var STORAGE_KEY = 'mh_bibli:' + slug;
    var DEFAULT_STATE = {
        lastSearch: { titre: '', artiste: '', genre: '', niveau: 'intermediaire' },
        lastTempo: null,
        lastTransposition: 0
    };

    function loadPersisted() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
            var p = JSON.parse(raw);
            return {
                lastSearch: Object.assign({}, DEFAULT_STATE.lastSearch, p.lastSearch || {}),
                lastTempo: typeof p.lastTempo === 'number' ? p.lastTempo : null,
                lastTransposition: typeof p.lastTransposition === 'number' ? p.lastTransposition : 0,
            };
        } catch (e) {
            return JSON.parse(JSON.stringify(DEFAULT_STATE));
        }
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                lastSearch: state.search,
                lastTempo: state.tempo,
                lastTransposition: state.transposition
            }));
        } catch (e) {}
    }

    // ═══ State ═══
    var persisted = loadPersisted();
    var state = {
        phase: 'search',                    // search | loading | results | not-found
        search: persisted.lastSearch,
        result: null,                       // payload from API
        tempo: persisted.lastTempo || 100,
        transposition: persisted.lastTransposition,  // demi-tons
        currentlyPlaying: false,
        currentChordIndex: 0,
        playbackTimers: [],
        flatChords: []                      // accords aplatis pour playback (avec ref ligne/section)
    };

    // ═══ Suggestions de morceaux ═══
    var SUGGESTIONS = [
        { titre: 'La Bohème',      artiste: 'Aznavour' },
        { titre: 'Imagine',        artiste: 'Lennon' },
        { titre: 'Hallelujah',     artiste: 'Cohen' },
        { titre: 'Amazing Grace',  artiste: '' },
        { titre: 'Cantaloupe Island', artiste: 'Hancock' },
        { titre: 'Let It Be',      artiste: 'Beatles' }
    ];

    var GENRES = [
        { id: '',                   label: '— Aucun —' },
        { id: 'variete-francaise',  label: 'Variété française' },
        { id: 'pop',                label: 'Pop' },
        { id: 'gospel',             label: 'Gospel' },
        { id: 'jazz',               label: 'Jazz' },
        { id: 'rock',               label: 'Rock' },
        { id: 'autre',              label: 'Autre' }
    ];

    var NIVEAUX = [
        { id: 'debutant',       label: 'Débutant' },
        { id: 'intermediaire',  label: 'Intermédiaire' },
        { id: 'avance',         label: 'Avancé' }
    ];

    // ═══ Sampler (lazy-init, pattern grilles.js) ═══
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

    // ═══ Normalisation chord names (LLM utilise notation jazz m7,
    // MhTheory veut min7) — repris de grilles.js ═══
    function normalizeChord(name) {
        var n = String(name).trim();
        n = n.replace(/ø7?/g, 'min7b5');
        n = n.replace(/Δ/g, 'maj');
        n = n.replace(/^([A-G][#b]?)mMaj7/i, '$1mMaj7');
        n = n.replace(/^([A-G][#b]?)m7b5\b/, '$1min7b5');
        n = n.replace(/^([A-G][#b]?)m11\b/,  '$1min11');
        n = n.replace(/^([A-G][#b]?)m7\b/,   '$1min7');
        n = n.replace(/^([A-G][#b]?)m6\b/,   '$1min6');
        n = n.replace(/^([A-G][#b]?)m(?![A-Za-z0-9#b])/, '$1min');
        return n;
    }

    function chordToNotes(chordName) {
        var normalized = normalizeChord(chordName);
        var parsed = MT.parseChord(normalized);
        if (parsed) {
            try { return MT.buildChord(parsed.root + '4', parsed.type); } catch (e) {}
        }
        var m = String(chordName).match(/^([A-G][#b]?)/);
        if (m) {
            try { return MT.buildChord(m[1] + '4', 'maj'); } catch (e) {}
        }
        return [];
    }

    // ═══ Transpose : préserve le suffixe, transpose juste la racine ═══
    // Préserve la notation jazz (Cm7 reste Cm7, pas Cmin7)
    function transposeChordName(name, semis) {
        if (semis === 0) return name;
        var m = String(name).match(/^([A-G][#b]?)(.*)$/);
        if (!m) return name;
        try {
            var newRoot = MT.transposeBySemitones(m[1], semis);
            return newRoot + m[2];
        } catch (e) {
            return name;
        }
    }

    // ═══ ChordPro parsing ═══
    // Tokenize une ligne "[Dm]Je vous parle [Bm7b5]d'un temps"
    // Retourne [{type:'chord', value:'Dm'}, {type:'lyric', value:'Je vous parle '}, ...]
    function parseChordProLine(line) {
        var tokens = [];
        var cursor = 0;
        var re = /\[([^\]]+)\]/g;
        var m;
        while ((m = re.exec(line)) !== null) {
            if (m.index > cursor) tokens.push({ type: 'lyric', value: line.substring(cursor, m.index) });
            tokens.push({ type: 'chord', value: m[1] });
            cursor = m.index + m[0].length;
        }
        if (cursor < line.length) tokens.push({ type: 'lyric', value: line.substring(cursor) });
        return tokens;
    }

    // Render une ligne en 2 div (chords + lyrics) alignées via padding monospace.
    // chordIdxStart = index global du 1er accord de cette ligne (pour highlight playback)
    function renderChordProLine(line, transposeSemis, chordIdxStart) {
        var tokens = parseChordProLine(line);
        var chordsRow = '';
        var lyricsRow = '';
        var chordCounter = 0;

        for (var i = 0; i < tokens.length; i++) {
            var tok = tokens[i];
            if (tok.type === 'chord') {
                // Pad chordsRow jusqu'à la longueur visible courante de lyricsRow
                while (visibleLen(chordsRow) < lyricsRow.length) chordsRow += ' ';
                var displayChord = transposeChordName(tok.value, transposeSemis);
                var globalIdx = chordIdxStart + chordCounter;
                chordsRow += '<span class="chord-tok" data-cidx="' + globalIdx + '">' + escapeHtml(displayChord) + '</span> ';
                chordCounter++;
                // Pad lyricsRow jusqu'à la longueur visible des chords (mais en char espaces)
                while (lyricsRow.length < visibleLen(chordsRow)) lyricsRow += ' ';
            } else {
                lyricsRow += tok.value;
            }
        }
        // Vide → utiliser un nbsp pour préserver la hauteur
        var chOut = chordsRow.length ? chordsRow : ' ';
        var lyOut = lyricsRow.length ? escapeHtml(lyricsRow) : ' ';
        return {
            html:
                '<div class="cp-line">' +
                    '<div class="cp-chords">' + chOut + '</div>' +
                    '<div class="cp-lyrics">' + lyOut + '</div>' +
                '</div>',
            chordCount: chordCounter
        };
    }

    // Compte la longueur visible d'une string mixte (HTML span + texte)
    function visibleLen(htmlOrText) {
        // Strip les tags et compte les caractères texte (avec espaces)
        return htmlOrText.replace(/<[^>]+>/g, '').length;
    }

    // ═══ Aplatissement des accords pour playback ═══
    // Parcourt toutes les sections × lignes et collecte la séquence linéaire
    // d'accords avec leur index global (pour highlight pendant playback).
    function buildFlatChords(sections) {
        var flat = [];
        for (var s = 0; s < sections.length; s++) {
            var lines = sections[s].lines || [];
            for (var l = 0; l < lines.length; l++) {
                var tokens = parseChordProLine(lines[l]);
                for (var t = 0; t < tokens.length; t++) {
                    if (tokens[t].type === 'chord') {
                        flat.push({
                            chord: tokens[t].value,
                            sectionIdx: s,
                            lineIdx: l
                        });
                    }
                }
            }
        }
        return flat;
    }

    // ═══ Audio playback ═══
    function clearTimers() {
        for (var i = 0; i < state.playbackTimers.length; i++) clearTimeout(state.playbackTimers[i]);
        state.playbackTimers = [];
    }

    var FADE_MS = 150;
    function stopPlayback(opts) {
        opts = opts || {};
        clearTimers();
        var wasPlaying = state.currentlyPlaying;
        state.currentlyPlaying = false;
        state.currentChordIndex = 0;

        if (sampler) {
            if (opts.immediate) {
                try { sampler.releaseAll(); } catch (e) {}
                try {
                    if (sampler.volume.cancelScheduledValues) sampler.volume.cancelScheduledValues(Tone.now());
                    sampler.volume.value = 0;
                } catch (e) {}
            } else {
                try { sampler.volume.rampTo(-Infinity, FADE_MS / 1000); } catch (e) {}
                setTimeout(function () { try { sampler.releaseAll(); } catch (e) {} }, FADE_MS + 20);
            }
        }
        if (wasPlaying) {
            setTimeout(function () { updatePlayButton(); clearChordHighlight(); },
                       opts.immediate ? 0 : FADE_MS + 10);
        }
    }

    function startPlayback() {
        if (state.currentlyPlaying) {
            stopPlayback();
            return;
        }
        if (!state.flatChords.length) return;

        ensureAudio().then(function () {
            if (!sampler) return;
            try {
                if (sampler.volume.cancelScheduledValues) sampler.volume.cancelScheduledValues(Tone.now());
                sampler.volume.value = 0;
            } catch (e) {}

            state.currentlyPlaying = true;
            state.currentChordIndex = 0;
            updatePlayButton();
            playNextChord();
        }).catch(function (err) {
            console.warn('[bibli] audio fail', err);
            showToast('Erreur audio : ' + (err.message || 'sampler'));
            state.currentlyPlaying = false;
            updatePlayButton();
        });
    }

    function playNextChord() {
        if (!state.currentlyPlaying) return;
        if (state.currentChordIndex >= state.flatChords.length) {
            // Fin
            state.currentlyPlaying = false;
            state.currentChordIndex = 0;
            updatePlayButton();
            clearChordHighlight();
            return;
        }

        var idx = state.currentChordIndex;
        var entry = state.flatChords[idx];
        var transposed = transposeChordName(entry.chord, state.transposition);
        var notes = chordToNotes(transposed);
        var beatSec = 60 / state.tempo;
        var measureSec = beatSec * 4;
        var releaseRatio = 0.95;

        highlightChord(idx);
        if (notes.length && sampler) {
            try { sampler.triggerAttackRelease(notes, measureSec * releaseRatio); } catch (e) {}
        }

        var t = setTimeout(function () {
            state.currentChordIndex++;
            playNextChord();
        }, measureSec * 1000);
        state.playbackTimers.push(t);
    }

    function highlightChord(globalIdx) {
        clearChordHighlight();
        var el = document.querySelector('.chord-tok[data-cidx="' + globalIdx + '"]');
        if (el) {
            el.classList.add('is-playing');
            // Scroll dans la vue si nécessaire
            try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (e) {}
        }
    }
    function clearChordHighlight() {
        var els = document.querySelectorAll('.chord-tok.is-playing');
        for (var i = 0; i < els.length; i++) els[i].classList.remove('is-playing');
    }
    function updatePlayButton() {
        var btn = $('btn-play');
        if (!btn) return;
        if (state.currentlyPlaying) {
            btn.textContent = '■ Stop';
            btn.classList.add('is-playing');
        } else {
            btn.textContent = '▶ Jouer la grille';
            btn.classList.remove('is-playing');
        }
    }

    // ═══ API call ═══
    function searchSong() {
        if (state.phase === 'loading') return;
        var titre = state.search.titre.trim();
        if (titre.length < 2) {
            showToast('Entre un titre (2 caractères minimum)');
            return;
        }
        state.phase = 'loading';
        renderAll();

        fetch('/api/bibli/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                titre: titre,
                artiste: state.search.artiste || '',
                genre: state.search.genre || '',
                niveau: state.search.niveau
            })
        }).then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        }).then(function (r) {
            if (!r.ok || !r.data || !r.data.ok) {
                var err = (r.data && r.data.error) || 'erreur inconnue';
                showToast('Génération échouée : ' + err);
                state.phase = 'search';
                renderAll();
                return;
            }
            if (r.data.found === false) {
                state.result = r.data;
                state.phase = 'not-found';
                renderAll();
                return;
            }
            state.result = r.data;
            state.flatChords = buildFlatChords(r.data.sections);
            state.phase = 'results';
            // Tempo : si l'utilisateur n'a pas explicitement persisté un tempo, prendre celui du LLM
            if (state.tempo === 100 && r.data.bpm) {
                state.tempo = clampTempo(r.data.bpm);
            }
            persist();
            renderAll();
        }).catch(function (e) {
            console.error('[bibli] search failed:', e);
            showToast('Erreur réseau : ' + (e.message || ''));
            state.phase = 'search';
            renderAll();
        });
    }

    function clampTempo(v) {
        var n = parseInt(v, 10);
        if (isNaN(n)) return 100;
        return Math.max(40, Math.min(200, n));
    }

    // ═══ Rendu UI ═══
    function $(id) { return document.getElementById(id); }
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function renderAll() {
        if (state.phase === 'search')         renderSearch();
        else if (state.phase === 'loading')   renderLoading();
        else if (state.phase === 'not-found') renderNotFound();
        else                                  renderResults();
    }

    function renderSearch() {
        var sub = $('page-subtitle');
        if (sub) sub.textContent = 'Trouve un morceau, joue les accords';

        var s = state.search;
        var html = '<div class="search-card">';

        html += '<div class="field">';
        html +=   '<label for="f-titre">Titre du morceau <span style="color:var(--red)">*</span></label>';
        html +=   '<input type="text" id="f-titre" placeholder="ex: La Bohème, Imagine, Hallelujah" value="' + escapeHtml(s.titre) + '" autocomplete="off" />';
        html += '</div>';

        html += '<div class="field">';
        html +=   '<label for="f-artiste">Artiste (optionnel)</label>';
        html +=   '<input type="text" id="f-artiste" placeholder="ex: Aznavour, Lennon" value="' + escapeHtml(s.artiste) + '" autocomplete="off" />';
        html += '</div>';

        html += '<div class="field">';
        html +=   '<label for="f-genre">Genre (optionnel)</label>';
        html +=   '<select id="f-genre">';
        for (var i = 0; i < GENRES.length; i++) {
            var g = GENRES[i];
            var sel = g.id === s.genre ? ' selected' : '';
            html +=    '<option value="' + escapeHtml(g.id) + '"' + sel + '>' + escapeHtml(g.label) + '</option>';
        }
        html +=   '</select>';
        html += '</div>';

        html += '<div class="field">';
        html +=   '<label>Niveau de difficulté <span style="color:var(--red)">*</span></label>';
        html +=   '<div class="niveau-pills" id="niveau-pills">';
        for (var j = 0; j < NIVEAUX.length; j++) {
            var n = NIVEAUX[j];
            var act = n.id === s.niveau ? ' active' : '';
            html +=    '<button type="button" class="niveau-pill' + act + '" data-niveau="' + n.id + '">' + escapeHtml(n.label) + '</button>';
        }
        html +=   '</div>';
        html += '</div>';

        html += '<button type="button" class="btn-primary" id="btn-search">🔍 Chercher</button>';
        html += '</div>';

        // Suggestions
        html += '<div class="suggestions">';
        html +=   '<div class="section-label">Idées de morceaux</div>';
        html +=   '<div class="suggestion-chips">';
        for (var k = 0; k < SUGGESTIONS.length; k++) {
            var sug = SUGGESTIONS[k];
            var lab = sug.titre + (sug.artiste ? ' (' + sug.artiste + ')' : '');
            html += '<button type="button" class="suggestion-chip" data-sug="' + k + '">' + escapeHtml(lab) + '</button>';
        }
        html +=   '</div>';
        html += '</div>';

        $('main-area').innerHTML = html;

        // Wire
        $('f-titre').addEventListener('input', function (e) { state.search.titre = e.target.value; });
        $('f-artiste').addEventListener('input', function (e) { state.search.artiste = e.target.value; });
        $('f-genre').addEventListener('change', function (e) { state.search.genre = e.target.value; });

        $('niveau-pills').addEventListener('click', function (e) {
            var b = e.target.closest('button[data-niveau]');
            if (!b) return;
            state.search.niveau = b.getAttribute('data-niveau');
            renderSearch(); // re-render pour mettre à jour la pill active
        });

        $('btn-search').addEventListener('click', searchSong);
        $('f-titre').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); searchSong(); }
        });
        $('f-artiste').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); searchSong(); }
        });

        document.querySelector('.suggestion-chips').addEventListener('click', function (e) {
            var b = e.target.closest('button[data-sug]');
            if (!b) return;
            var idx = parseInt(b.getAttribute('data-sug'), 10);
            var sug = SUGGESTIONS[idx];
            if (!sug) return;
            state.search.titre = sug.titre;
            state.search.artiste = sug.artiste;
            persist();
            searchSong();
        });
    }

    function renderLoading() {
        var sub = $('page-subtitle');
        if (sub) sub.textContent = 'Recherche en cours…';
        $('main-area').innerHTML =
            '<div class="state-card">' +
                '<div class="spinner"></div>' +
                '<div class="msg">Génération des accords par IA…</div>' +
                '<div class="sub">Quelques secondes</div>' +
            '</div>';
    }

    function renderNotFound() {
        var sub = $('page-subtitle');
        if (sub) sub.textContent = 'Morceau introuvable';
        var msg = (state.result && state.result.message) || 'Morceau non trouvé. Essaie un autre titre ou ajoute le nom de l\'artiste.';
        $('main-area').innerHTML =
            '<div class="state-card">' +
                '<div class="icon">🔍</div>' +
                '<div class="msg">' + escapeHtml(msg) + '</div>' +
                '<button type="button" class="btn-secondary" id="btn-back-search">← Nouvelle recherche</button>' +
            '</div>';
        $('btn-back-search').addEventListener('click', function () {
            state.phase = 'search';
            state.result = null;
            renderAll();
        });
    }

    function renderResults() {
        var r = state.result;
        if (!r) { state.phase = 'search'; renderAll(); return; }

        var sub = $('page-subtitle');
        if (sub) sub.textContent = (r.tonalite_label_fr || r.tonalite || '') + ' · ' + r.bpm + ' BPM';

        var transposeLabel = state.transposition === 0 ? 'Tonalité originale'
                            : (state.transposition > 0 ? '+' + state.transposition : state.transposition) + ' demi-ton' + (Math.abs(state.transposition) > 1 ? 's' : '');

        var html = '';
        // Result head
        html += '<div class="result-head">';
        html +=   '<div class="titre">' + escapeHtml(r.titre || '') + '</div>';
        if (r.artiste) html += '<div class="artiste">' + escapeHtml(r.artiste) + '</div>';
        html +=   '<div class="meta">';
        if (r.tonalite_label_fr) html += '<span>' + escapeHtml(r.tonalite_label_fr) + '</span>';
        if (r.bpm) html += '<span>' + escapeHtml(String(r.bpm)) + ' BPM</span>';
        if (r.genre) html += '<span>' + escapeHtml(r.genre) + '</span>';
        html +=   '</div>';
        html += '</div>';

        // Toolbar
        html += '<div class="toolbar">';
        html +=   '<button type="button" class="btn-secondary" id="btn-modify">← Modifier</button>';
        html +=   '<div class="tool-row tempo-row">';
        html +=     '<span style="font-size:0.78rem;color:var(--text-muted);">Tempo</span>';
        html +=     '<input type="range" id="tempo-slider" min="40" max="200" step="1" value="' + state.tempo + '" />';
        html +=     '<span class="tempo-value" id="tempo-value">' + state.tempo + ' BPM</span>';
        html +=   '</div>';
        html +=   '<div class="transpose-row">';
        html +=     '<button type="button" class="btn-transpose" id="btn-tdown" title="Transpose -1/2 ton">🔻</button>';
        html +=     '<span class="transpose-value" id="transpose-value">' + escapeHtml(transposeLabel) + '</span>';
        html +=     '<button type="button" class="btn-transpose" id="btn-tup" title="Transpose +1/2 ton">🔺</button>';
        html +=   '</div>';
        var playLabel = state.currentlyPlaying ? '■ Stop' : '▶ Jouer la grille';
        var playClass = state.currentlyPlaying ? 'btn-secondary is-playing' : 'btn-secondary';
        html +=   '<button type="button" class="' + playClass + '" id="btn-play">' + escapeHtml(playLabel) + '</button>';
        html += '</div>';

        // Sections
        html += '<div class="sections-wrap">';
        var globalChordIdx = 0;
        for (var i = 0; i < r.sections.length; i++) {
            var section = r.sections[i];
            html += '<div class="section-block">';
            html +=   '<div class="section-label-prog">' + escapeHtml(section.label || ('Section ' + (i + 1))) + '</div>';
            for (var j = 0; j < section.lines.length; j++) {
                var rendered = renderChordProLine(section.lines[j], state.transposition, globalChordIdx);
                html += rendered.html;
                globalChordIdx += rendered.chordCount;
            }
            html += '</div>';
        }
        html += '</div>';

        $('main-area').innerHTML = html;

        // Wire
        $('btn-modify').addEventListener('click', function () {
            stopPlayback({ immediate: true });
            state.phase = 'search';
            renderAll();
        });
        $('btn-play').addEventListener('click', startPlayback);

        var tSlider = $('tempo-slider');
        var tValue  = $('tempo-value');
        if (tSlider && tValue) {
            tSlider.addEventListener('input', function () {
                state.tempo = clampTempo(tSlider.value);
                tValue.textContent = state.tempo + ' BPM';
                persist();
            });
        }

        $('btn-tdown').addEventListener('click', function () {
            state.transposition = Math.max(-12, state.transposition - 1);
            persist();
            renderResults(); // re-render lignes avec nouvelle transposition
        });
        $('btn-tup').addEventListener('click', function () {
            state.transposition = Math.min(12, state.transposition + 1);
            persist();
            renderResults();
        });
    }

    // ═══ Toast ═══
    var toastTimer = null;
    function showToast(msg) {
        var toast = $('toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('is-visible');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, 3500);
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
