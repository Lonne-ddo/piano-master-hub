// ─── Master Hub — Théorie musicale partagée ─────────────────────────
// Module IIFE qui expose window.MhTheory.
// Source de vérité pour : chromatique, notes FR, intervalles, accords (22 types
// convention jazz), parseChord, transposition, formatting français.
// Consommé par quiz-engine.js et (futur) Dictionnaire d'accords + Grilles.

(function () {
    'use strict';

    // ═══════════════ CHROMATIQUES ═══════════════
    var CHROMATIC_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    var CHROMATIC_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

    var FLAT_TO_SHARP = { 'Db':'C#', 'Eb':'D#', 'Gb':'F#', 'Ab':'G#', 'Bb':'A#', 'Cb':'B', 'Fb':'E' };
    var SHARP_TO_FLAT = { 'C#':'Db', 'D#':'Eb', 'F#':'Gb', 'G#':'Ab', 'A#':'Bb' };

    // ═══════════════ NOTES FR (Unicode ♯/♭) ═══════════════
    // Source : convention quiz-engine.js (utilise les caractères Unicode plutôt
    // que # et b pour rendu visuel propre).
    var NOTES_FR_SHARP = {
        'C':'Do', 'C#':'Do\u266F', 'D':'Ré', 'D#':'Ré\u266F', 'E':'Mi', 'F':'Fa',
        'F#':'Fa\u266F', 'G':'Sol', 'G#':'Sol\u266F', 'A':'La', 'A#':'La\u266F', 'B':'Si'
    };
    var NOTES_FR_FLAT = {
        'C':'Do', 'Db':'Ré\u266D', 'D':'Ré', 'Eb':'Mi\u266D', 'E':'Mi', 'F':'Fa',
        'Gb':'Sol\u266D', 'G':'Sol', 'Ab':'La\u266D', 'A':'La', 'Bb':'Si\u266D', 'B':'Si'
    };

    // ═══════════════ INTERVALLES (14 entrées) ═══════════════
    // Naming verbatim quiz-engine.js (consommé par boutons quiz-play).
    var INTERVAL_TYPES = [
        { id: 'm2', name: 'Demi-ton (m2)',    semis: 1  },
        { id: 'M2', name: 'Ton (M2)',         semis: 2  },
        { id: 'm3', name: 'Tierce m (m3)',    semis: 3  },
        { id: 'M3', name: 'Tierce M (M3)',    semis: 4  },
        { id: 'P4', name: 'Quarte (P4)',      semis: 5  },
        { id: 'TT', name: 'Triton (TT)',      semis: 6  },
        { id: 'P5', name: 'Quinte (P5)',      semis: 7  },
        { id: 'm6', name: 'Sixte m (m6)',     semis: 8  },
        { id: 'M6', name: 'Sixte M (M6)',     semis: 9  },
        { id: 'm7', name: 'Septième m (m7)',  semis: 10 },
        { id: 'M7', name: 'Septième M (M7)',  semis: 11 },
        { id: 'P8', name: 'Octave (P8)',      semis: 12 },
        { id: 'm9', name: 'Neuvième m',       semis: 13 },
        { id: 'M9', name: 'Neuvième M',       semis: 14 }
    ];

    // ═══════════════ ACCORDS (22 types, convention « min ») ═══════════════
    // Convention « min » alignée avec le quiz CHORD_TYPES_QUIZ (m7 → min7 etc.).
    // Inclut les dominantes altérées courantes en jazz : 7b9, 7#5, 7#9.
    var CHORD_TYPES = {
        // Triades de base
        'maj':    { name: 'Majeur',                 intervals: [0,4,7],          ivLabels: ['1','3','5'] },
        'min':    { name: 'Mineur',                 intervals: [0,3,7],          ivLabels: ['1','b3','5'] },
        'dim':    { name: 'Diminué',                intervals: [0,3,6],          ivLabels: ['1','b3','b5'] },
        'aug':    { name: 'Augmenté',               intervals: [0,4,8],          ivLabels: ['1','3','#5'] },
        'sus2':   { name: 'Suspendu 2',             intervals: [0,2,7],          ivLabels: ['1','2','5'] },
        'sus4':   { name: 'Suspendu 4',             intervals: [0,5,7],          ivLabels: ['1','4','5'] },

        // Septièmes
        '7':      { name: 'Septième de dominante',  intervals: [0,4,7,10],       ivLabels: ['1','3','5','b7'] },
        'maj7':   { name: 'Septième majeure',       intervals: [0,4,7,11],       ivLabels: ['1','3','5','7'] },
        'min7':   { name: 'Septième mineure',       intervals: [0,3,7,10],       ivLabels: ['1','b3','5','b7'] },
        'min7b5': { name: 'Demi-diminué (m7b5)',    intervals: [0,3,6,10],       ivLabels: ['1','b3','b5','b7'] },
        'dim7':   { name: 'Diminué 7',              intervals: [0,3,6,9],        ivLabels: ['1','b3','b5','bb7'] },
        'mMaj7':  { name: 'Mineur Maj7',            intervals: [0,3,7,11],       ivLabels: ['1','b3','5','7'] },

        // Sixtes
        '6':      { name: 'Sixte',                  intervals: [0,4,7,9],        ivLabels: ['1','3','5','6'] },
        'min6':   { name: 'Mineur sixte',           intervals: [0,3,7,9],        ivLabels: ['1','b3','5','6'] },

        // Ajouts
        'add9':   { name: 'Add 9',                  intervals: [0,4,7,14],       ivLabels: ['1','3','5','9'] },

        // Extensions tensions
        '9':      { name: 'Dominante 9',            intervals: [0,4,7,10,14],    ivLabels: ['1','3','5','b7','9'] },
        '13':     { name: 'Dominante 13',           intervals: [0,4,7,10,14,21], ivLabels: ['1','3','5','b7','9','13'] },
        'min11':  { name: 'Mineur 11',              intervals: [0,3,7,10,14,17], ivLabels: ['1','b3','5','b7','9','11'] },

        // Sus dominantes
        '7sus4':  { name: 'Dominante sus4',         intervals: [0,5,7,10],       ivLabels: ['1','4','5','b7'] },

        // Altérées (dominantes avec altérations courantes)
        '7b9':    { name: 'Dominante b9',           intervals: [0,4,7,10,13],    ivLabels: ['1','3','5','b7','b9'] },
        '7#5':    { name: 'Dominante #5 (alt)',     intervals: [0,4,8,10],       ivLabels: ['1','3','#5','b7'] },
        '7#9':    { name: 'Dominante #9',           intervals: [0,4,7,10,15],    ivLabels: ['1','3','5','b7','#9'] }
    };

    // ═══════════════ HELPERS ═══════════════

    function toSharp(note) { return FLAT_TO_SHARP[note] || note; }
    function toFlat(note)  { return SHARP_TO_FLAT[note] || note; }

    // Affichage FR : noteToFr('C#') → 'Do♯' ; noteToFr('Bb', { useFlat: true }) → 'Si♭'
    function noteToFr(note, opts) {
        opts = opts || {};
        if (!note) return '';
        // Strip octave si présente
        var base = String(note).replace(/\d+$/, '');
        if (opts.useFlat) {
            var asFlat = toFlat(base);
            return NOTES_FR_FLAT[asFlat] || base;
        }
        var asSharp = toSharp(base);
        return NOTES_FR_SHARP[asSharp] || base;
    }

    // Helper interne : depuis "C", "Db", "C#3" ou "C4" → { name, octave|null }
    function parseRoot(rootStr) {
        var m = String(rootStr).match(/^([A-G][#b]?)(\d+)?$/);
        if (!m) return null;
        return {
            name: m[1],
            octave: m[2] ? parseInt(m[2], 10) : null
        };
    }

    // Construit les notes à partir d'une root (avec ou sans octave) + tableau d'intervalles.
    // notesFromIntervals('C3', [0, 4, 7]) → ['C3', 'E3', 'G3']
    // notesFromIntervals('C', [0, 4, 7])  → ['C', 'E', 'G']
    // notesFromIntervals('Bb4', [0, 3, 7]) → ['Bb4', 'Db5', 'F5'] (préserve la convention bémol)
    function notesFromIntervals(rootStr, intervals) {
        var parsed = parseRoot(rootStr);
        if (!parsed) throw new Error('Invalid root: ' + rootStr);
        var inputIsFlat = parsed.name.indexOf('b') > 0;
        var sharpName = toSharp(parsed.name);
        var baseIdx = CHROMATIC_SHARP.indexOf(sharpName);
        if (baseIdx < 0) throw new Error('Unknown note: ' + parsed.name);

        return intervals.map(function (semi) {
            var total = baseIdx + semi;
            var idx = ((total % 12) + 12) % 12;
            var name = CHROMATIC_SHARP[idx];
            if (inputIsFlat) name = toFlat(name);
            if (parsed.octave !== null) {
                var oct = parsed.octave + Math.floor(total / 12);
                return name + oct;
            }
            return name;
        });
    }

    // Retourne la note supérieure à n demi-tons. Garde format avec octave.
    // getUpperNote('C3', 7) → 'G3' ; getUpperNote('C3', 12) → 'C4'
    function getUpperNote(rootWithOctave, semis) {
        var notes = notesFromIntervals(rootWithOctave, [semis]);
        return notes[0];
    }

    // Transposition simple par n demi-tons (sans octave).
    // transposeBySemitones('C', 7) → 'G' ; transposeBySemitones('Bb', 5) → 'Eb'
    function transposeBySemitones(note, semis) {
        return notesFromIntervals(note, [semis])[0];
    }

    // Construit un accord depuis sa root + son type (id de CHORD_TYPES).
    // buildChord('C', 'maj7') → ['C', 'E', 'G', 'B']
    // buildChord('F#3', 'm7') → ['F#3', 'A3', 'C#4', 'E4']
    function buildChord(root, type) {
        var def = CHORD_TYPES[type];
        if (!def) throw new Error('Unknown chord type: ' + type);
        return notesFromIntervals(root, def.intervals);
    }

    // Parse un nom d'accord "Cmaj7" ou "F#min7b5" en { root, type, notes }.
    // Retourne null si non parsable. Ordre alternation : suffixes longs d'abord
    // pour éviter qu'un suffixe court court-circuite un long (min vs min7 vs min7b5).
    var CHORD_NAME_RE = /^([A-G][#b]?)(min7b5|mMaj7|7sus4|min11|maj7|min7|min6|dim7|add9|sus2|sus4|7b9|7#5|7#9|maj|min|dim|aug|13|9|7|6)?$/;
    function parseChord(name) {
        var m = String(name).match(CHORD_NAME_RE);
        if (!m) return null;
        var root = m[1];
        var type = m[2] || 'maj';
        if (!CHORD_TYPES[type]) return null;
        return {
            root: root,
            type: type,
            notes: buildChord(root, type)
        };
    }

    // ═══════════════ EXPORT ═══════════════
    window.MhTheory = {
        // Constantes
        CHROMATIC_SHARP: CHROMATIC_SHARP,
        CHROMATIC_FLAT:  CHROMATIC_FLAT,
        FLAT_TO_SHARP:   FLAT_TO_SHARP,
        SHARP_TO_FLAT:   SHARP_TO_FLAT,
        NOTES_FR_SHARP:  NOTES_FR_SHARP,
        NOTES_FR_FLAT:   NOTES_FR_FLAT,
        INTERVAL_TYPES:  INTERVAL_TYPES,
        CHORD_TYPES:     CHORD_TYPES,
        // Helpers
        toSharp:              toSharp,
        toFlat:               toFlat,
        noteToFr:             noteToFr,
        notesFromIntervals:   notesFromIntervals,
        buildChord:           buildChord,
        parseChord:           parseChord,
        transposeBySemitones: transposeBySemitones,
        getUpperNote:         getUpperNote
    };
})();
