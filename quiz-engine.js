// ─── Master Hub — Quiz engine factorisé ───────────────────────────
// Module unique pour les 3 modes : notes | intervals | chords.
// Réutilise les catalogues + sampler nbrosowsky de Piano Key.
// Usage :
//   const engine = new QuizEngine({ mode, level, slug, totalQuestions: 10 });
//   await engine.init();
//   engine.generateQuestions();
//   await engine.playCurrent();
//   const r = engine.pick(answerId); // {correct, expected}
//   engine.next();                    // ou engine.isFinished()
//   await engine.finish();            // POST /api/quiz/submit

(function () {
    'use strict';

    // ─── Catalogues importés verbatim depuis Piano Key ────────────
    var NOTES = [
        { id: 'C',  name: 'C'  }, { id: 'C#', name: 'C#' },
        { id: 'D',  name: 'D'  }, { id: 'D#', name: 'D#' },
        { id: 'E',  name: 'E'  }, { id: 'F',  name: 'F'  },
        { id: 'F#', name: 'F#' }, { id: 'G',  name: 'G'  },
        { id: 'G#', name: 'G#' }, { id: 'A',  name: 'A'  },
        { id: 'A#', name: 'A#' }, { id: 'B',  name: 'B'  }
    ];

    var NOTE_TONES = {
        'C':  ['C3','C4','C5'],   'C#': ['Db3','Db4','Db5'],
        'D':  ['D3','D4','D5'],   'D#': ['Eb3','Eb4','Eb5'],
        'E':  ['E3','E4','E5'],   'F':  ['F3','F4','F5'],
        'F#': ['F#3','F#4','F#5'],'G':  ['G3','G4','G5'],
        'G#': ['Ab3','Ab4','Ab5'],'A':  ['A3','A4','A5'],
        'A#': ['Bb3','Bb4','Bb5'],'B':  ['B3','B4','B5']
    };

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

    var CHROMATIC_IV  = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
    var BASE_ROOTS_IV = ['C3','D3','E3','F3','G3','A3'];

    var CHORD_TYPES_QUIZ = [
        { id: 'maj',   name: 'Majeur',   intervals: [0,4,7]          },
        { id: 'min',   name: 'Mineur',   intervals: [0,3,7]          },
        { id: 'dim',   name: 'Diminué',  intervals: [0,3,6]          },
        { id: 'aug',   name: 'Augmenté', intervals: [0,4,8]          },
        { id: '7',     name: 'Dom 7',    intervals: [0,4,7,10]       },
        { id: 'maj7',  name: 'Maj 7',    intervals: [0,4,7,11]       },
        { id: 'm7',    name: 'Min 7',    intervals: [0,3,7,10]       },
        { id: 'maj9',  name: 'Maj 9',    intervals: [0,4,7,11,14]    },
        { id: 'min9',  name: 'Min 9',    intervals: [0,3,7,10,14]    },
        { id: 'min11', name: 'Min 11',   intervals: [0,3,7,10,14,17] }
    ];

    var BASE_NOTES_CH = ['C4','D4','E4','F4','G4','A4'];

    // ─── Gammes (commit 2b.2) ─────────────────────────────────────
    // Mineure naturelle uniquement (mode aeolien). Intervals incluent
    // l'octave (12) pour rendre la gamme complète à l'écoute.
    var SCALE_TYPES = [
        { id: 'major', name: 'Majeure', intervals: [0, 2, 4, 5, 7, 9, 11, 12] },
        { id: 'minor', name: 'Mineure', intervals: [0, 2, 3, 5, 7, 8, 10, 12] }
    ];

    var NOTE_FR = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };

    function noteToFr(noteName) {
        if (!noteName) return '';
        var base = String(noteName).replace(/\d+$/, '');
        var natural = base.charAt(0);
        var fr = NOTE_FR[natural] || natural;
        if (base.length > 1) {
            var accidental = base.charAt(1);
            if (accidental === '#') return fr + '\u266F';
            if (accidental === 'b' || accidental === 'B') return fr + '\u266D';
        }
        return fr;
    }

    // ─── Progressions diatoniques en Do majeur (commit 2b.2) ──────
    // Triades simples : I=C E G | ii=D F A | iii=E G B | IV=F A C | V=G B D | vi=A C E
    var TRIADS_C_MAJOR = {
        'I':   ['C4','E4','G4'],
        'ii':  ['D4','F4','A4'],
        'iii': ['E4','G4','B4'],
        'IV':  ['F4','A4','C5'],
        'V':   ['G4','B4','D5'],
        'vi':  ['A4','C5','E5']
    };

    var PROGRESSION_POOL = [
        { id: 'I_IV_V',     name: 'I - IV - V',                   chords: ['I','IV','V']       },
        { id: 'I_V_vi_IV',  name: 'I - V - vi - IV',              chords: ['I','V','vi','IV']  },
        { id: 'ii_V_I',     name: 'ii - V - I',                   chords: ['ii','V','I']       },
        { id: 'I_vi_IV_V',  name: 'I - vi - IV - V (50s)',        chords: ['I','vi','IV','V']  },
        { id: 'vi_IV_I_V',  name: 'vi - IV - I - V (axis)',       chords: ['vi','IV','I','V']  },
        { id: 'canon',      name: 'Canon (I-V-vi-iii-IV-I-IV-V)', chords: ['I','V','vi','iii','IV','I','IV','V'] },
        { id: 'I_iii_IV_V', name: 'I - iii - IV - V',             chords: ['I','iii','IV','V'] },
        { id: 'vi_ii_V_I',  name: 'vi - ii - V - I',              chords: ['vi','ii','V','I']  }
    ];

    // ─── Configuration des niveaux par mode ─────────────────────
    var QUIZ_DATA = {
        notes: {
            NOTES: NOTES,
            NOTE_TONES: NOTE_TONES,
            levelChoices: { debutant: 4, intermediaire: 7, avance: 12 },
            duration: 2
        },
        intervals: {
            INTERVAL_TYPES: INTERVAL_TYPES,
            CHROMATIC: CHROMATIC_IV,
            BASE_ROOTS: BASE_ROOTS_IV,
            // Pool d'intervalles autorisés par niveau (null = tous)
            levelFilter: {
                debutant: ['m3','M3','P5'],
                intermediaire: ['m2','M2','m3','M3','P4','P5','M6','M7'],
                avance: null
            },
            levelChoices: { debutant: 3, intermediaire: 4, avance: 6 }
        },
        chords: {
            CHORD_TYPES: CHORD_TYPES_QUIZ,
            CHROMATIC: CHROMATIC_IV,
            BASE_NOTES: BASE_NOTES_CH,
            levelFilter: {
                debutant: ['maj','min','dim'],
                intermediaire: ['maj','min','dim','aug','7','maj7','m7'],
                avance: null
            },
            levelChoices: { debutant: 3, intermediaire: 4, avance: 6 }
        },
        scales: {
            TYPES: SCALE_TYPES,
            CHROMATIC: CHROMATIC_IV,
            TONICS_BY_LEVEL: {
                debutant:      ['C'],
                intermediaire: ['C','D','E','F','G','A'],
                avance:        ['C','D','E','F','G','A']
            },
            OCTAVE: 4,
            REPLAY_BY_LEVEL: {
                debutant:      999,
                intermediaire: 2,
                avance:        1
            },
            NOTE_DURATION_S: 0.4
        },
        progressions: {
            POOL: PROGRESSION_POOL,
            TRIADS_C_MAJOR: TRIADS_C_MAJOR,
            POOL_BY_LEVEL: {
                debutant:      ['I_IV_V', 'I_V_vi_IV', 'ii_V_I'],
                intermediaire: ['I_IV_V', 'I_V_vi_IV', 'ii_V_I', 'I_vi_IV_V', 'vi_IV_I_V'],
                avance:        ['I_IV_V', 'I_V_vi_IV', 'ii_V_I', 'I_vi_IV_V', 'vi_IV_I_V', 'canon', 'I_iii_IV_V', 'vi_ii_V_I']
            },
            CHORD_DURATION_S: 1.0,
            GAP_S: 0.05
        }
    };

    // ─── Helpers ──────────────────────────────────────────────────
    function shuffle(arr) {
        return arr.slice().sort(function () { return Math.random() - 0.5; });
    }

    function pickRandom(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    function buildChordNotes(rootNote, intervals, chromatic) {
        var baseName = rootNote.replace(/\d/, '');
        var baseOct  = parseInt(rootNote.slice(-1), 10);
        var baseIdx  = chromatic.indexOf(baseName);
        return intervals.map(function (semi) {
            var total = baseIdx + semi;
            var name  = chromatic[total % 12];
            var oct   = baseOct + Math.floor(total / 12);
            return name + oct;
        });
    }

    function getUpperNote(rootNote, semis, chromatic) {
        var name  = rootNote.replace(/\d/, '');
        var oct   = parseInt(rootNote.slice(-1), 10);
        var idx   = chromatic.indexOf(name);
        var total = idx + semis;
        return chromatic[total % 12] + (oct + Math.floor(total / 12));
    }

    // ─── QuizEngine class ─────────────────────────────────────────
    function QuizEngine(opts) {
        opts = opts || {};
        this.mode = opts.mode;             // notes | intervals | chords | scales | progressions
        this.level = opts.level;            // debutant | intermediaire | avance
        this.slug = opts.slug;
        this.totalQuestions = opts.totalQuestions || 10;
        this.questions = [];
        this.cur = 0;
        this.score = 0;
        this.answered = false;
        this.replaysUsedForCurrent = 0; // utilisé par mode scales
        this.startedAt = Date.now();
        this.sampler = null;
        this.samplerReady = false;
    }

    QuizEngine.prototype.init = function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            // Restaure volume sauvegardé
            try {
                var savedVol = parseFloat(localStorage.getItem('masterhub_volume'));
                if (!isNaN(savedVol)) Tone.Destination.volume.value = savedVol;
            } catch (e) {}

            self.sampler = new Tone.Sampler({
                urls: {
                    'A1': 'A1.mp3', 'A2': 'A2.mp3', 'A3': 'A3.mp3', 'A4': 'A4.mp3',
                    'C2': 'C2.mp3', 'C3': 'C3.mp3', 'C4': 'C4.mp3', 'C5': 'C5.mp3',
                    'D#2': 'Ds2.mp3', 'D#3': 'Ds3.mp3', 'D#4': 'Ds4.mp3',
                    'F#2': 'Fs2.mp3', 'F#3': 'Fs3.mp3', 'F#4': 'Fs4.mp3'
                },
                release: 1.5,
                baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/piano/',
                onload: function () {
                    self.samplerReady = true;
                    resolve();
                },
                onerror: function (err) { reject(err); }
            }).toDestination();
        });
    };

    QuizEngine.prototype.generateQuestions = function () {
        var data = QUIZ_DATA[this.mode];
        if (!data) throw new Error('Mode inconnu : ' + this.mode);
        this.questions = [];
        for (var i = 0; i < this.totalQuestions; i++) {
            this.questions.push(this._buildQuestion(data));
        }
        this.cur = 0;
        this.score = 0;
        this.answered = false;
        this.replaysUsedForCurrent = 0;
    };

    QuizEngine.prototype._buildQuestion = function (data) {
        if (this.mode === 'notes') {
            var correctNote = pickRandom(data.NOTES);
            var tones = data.NOTE_TONES[correctNote.id];
            var tone = pickRandom(tones);
            var nChoices = data.levelChoices[this.level] || 4;
            var distractors = data.NOTES
                .filter(function (n) { return n.id !== correctNote.id; });
            distractors = shuffle(distractors).slice(0, nChoices - 1);
            var choices = shuffle(distractors.concat([correctNote]));
            return { correct: correctNote, choices: choices, payload: { tone: tone } };
        }

        if (this.mode === 'intervals') {
            var pool = this._filterByLevel(data.INTERVAL_TYPES, data.levelFilter);
            var correctIv = pickRandom(pool);
            var root = pickRandom(data.BASE_ROOTS);
            var direction = Math.random() < 0.5 ? 'asc' : 'desc';
            var nC = Math.min(data.levelChoices[this.level] || 4, pool.length);
            var dist = pool.filter(function (iv) { return iv.id !== correctIv.id; });
            dist = shuffle(dist).slice(0, nC - 1);
            var ivChoices = shuffle(dist.concat([correctIv]));
            return {
                correct: correctIv,
                choices: ivChoices,
                payload: { root: root, direction: direction }
            };
        }

        if (this.mode === 'chords') {
            var poolCh = this._filterByLevel(data.CHORD_TYPES, data.levelFilter);
            var correctCh = pickRandom(poolCh);
            var rootCh = pickRandom(data.BASE_NOTES);
            var nCC = Math.min(data.levelChoices[this.level] || 4, poolCh.length);
            var distCh = poolCh.filter(function (c) { return c.id !== correctCh.id; });
            distCh = shuffle(distCh).slice(0, nCC - 1);
            var chChoices = shuffle(distCh.concat([correctCh]));
            return {
                correct: correctCh,
                choices: chChoices,
                payload: { root: rootCh }
            };
        }

        if (this.mode === 'scales') {
            var correctScale = pickRandom(data.TYPES);
            var tonics = data.TONICS_BY_LEVEL[this.level] || ['C'];
            var tonic = pickRandom(tonics);
            // Toujours 2 boutons : Majeure / Mineure (ordre fixe)
            var scaleChoices = data.TYPES.slice();
            return {
                correct: correctScale,
                choices: scaleChoices,
                payload: { tonic: tonic, tonicFr: noteToFr(tonic) }
            };
        }

        if (this.mode === 'progressions') {
            var allowedIds = data.POOL_BY_LEVEL[this.level] || data.POOL.map(function (p) { return p.id; });
            var pool = data.POOL.filter(function (p) { return allowedIds.indexOf(p.id) >= 0; });
            var correctProg = pickRandom(pool);
            // Choix = pool entier du niveau (3/5/8 boutons), shuffled
            var progChoices = shuffle(pool.slice());
            return {
                correct: correctProg,
                choices: progChoices,
                payload: {}
            };
        }

        throw new Error('Mode inconnu : ' + this.mode);
    };

    QuizEngine.prototype._filterByLevel = function (catalogue, levelFilter) {
        var allowedIds = levelFilter[this.level];
        if (!allowedIds) return catalogue.slice();
        return catalogue.filter(function (item) {
            return allowedIds.indexOf(item.id) >= 0;
        });
    };

    QuizEngine.prototype.current = function () {
        return this.questions[this.cur];
    };

    QuizEngine.prototype.playCurrent = function () {
        var self = this;
        if (!self.samplerReady) return Promise.resolve();
        return Tone.start().then(function () {
            var q = self.current();
            if (!q) return;
            if (self.mode === 'notes') {
                var dur = QUIZ_DATA.notes.duration;
                self.sampler.triggerAttackRelease(q.payload.tone, dur);
            } else if (self.mode === 'intervals') {
                var data = QUIZ_DATA.intervals;
                var upper = getUpperNote(q.payload.root, q.correct.semis, data.CHROMATIC);
                var now = Tone.now();
                if (q.payload.direction === 'asc') {
                    self.sampler.triggerAttackRelease(q.payload.root, '2n', now);
                    self.sampler.triggerAttackRelease(upper, '2n', now + 0.6);
                } else {
                    self.sampler.triggerAttackRelease(upper, '2n', now);
                    self.sampler.triggerAttackRelease(q.payload.root, '2n', now + 0.6);
                }
            } else if (self.mode === 'chords') {
                var dataCh = QUIZ_DATA.chords;
                var notes = buildChordNotes(q.payload.root, q.correct.intervals, dataCh.CHROMATIC);
                var nowCh = Tone.now();
                notes.forEach(function (n) {
                    self.sampler.triggerAttackRelease(n, '2n', nowCh);
                });
            } else if (self.mode === 'scales') {
                // Replay limit (par niveau)
                var maxPlays = QUIZ_DATA.scales.REPLAY_BY_LEVEL[self.level] || 999;
                if (self.replaysUsedForCurrent >= maxPlays) return;
                self.replaysUsedForCurrent++;
                var sd = QUIZ_DATA.scales;
                var tonic = q.payload.tonic;
                var oct = sd.OCTAVE;
                var chrom = sd.CHROMATIC;
                var baseIdx = chrom.indexOf(tonic);
                var dur = sd.NOTE_DURATION_S;
                var nowSc = Tone.now();
                q.correct.intervals.forEach(function (semis, i) {
                    var totalSc = baseIdx + semis;
                    var noteName = chrom[totalSc % 12];
                    var noteOct = oct + Math.floor(totalSc / 12);
                    self.sampler.triggerAttackRelease(noteName + noteOct, dur, nowSc + i * dur);
                });
            } else if (self.mode === 'progressions') {
                var pd = QUIZ_DATA.progressions;
                var triads = pd.TRIADS_C_MAJOR;
                var durP = pd.CHORD_DURATION_S;
                var gap = pd.GAP_S;
                var nowP = Tone.now();
                q.correct.chords.forEach(function (chordId, i) {
                    var chordNotes = triads[chordId];
                    if (!chordNotes) return;
                    var t = nowP + i * (durP + gap);
                    chordNotes.forEach(function (n) {
                        self.sampler.triggerAttackRelease(n, durP, t);
                    });
                });
            }
        });
    };

    QuizEngine.prototype.pick = function (answerId) {
        if (this.answered) return null;
        var q = this.current();
        var correct = answerId === q.correct.id;
        if (correct) this.score++;
        this.answered = true;
        // Stocke la réponse dans la question pour le payload final
        q.given = answerId;
        q.isCorrect = correct;
        return { correct: correct, expected: q.correct };
    };

    QuizEngine.prototype.isFinished = function () {
        return this.cur >= this.totalQuestions - 1 && this.answered;
    };

    QuizEngine.prototype.next = function () {
        if (this.cur < this.totalQuestions - 1) {
            this.cur++;
            this.answered = false;
            this.replaysUsedForCurrent = 0;
            return true;
        }
        return false;
    };

    QuizEngine.prototype.canPlayCurrent = function () {
        if (this.mode !== 'scales') return true;
        var max = QUIZ_DATA.scales.REPLAY_BY_LEVEL[this.level] || 999;
        return this.replaysUsedForCurrent < max;
    };

    QuizEngine.prototype.finish = function () {
        var self = this;
        var duration = Date.now() - self.startedAt;
        var payload = {
            slug: self.slug,
            mode: self.mode,
            level: self.level,
            score: self.score,
            total: self.totalQuestions,
            duration_ms: duration,
            questions: self.questions.map(function (q) {
                return {
                    asked: q.correct.id,
                    asked_name: q.correct.name,
                    given: q.given || null,
                    correct: !!q.isCorrect
                };
            })
        };
        return fetch('/api/quiz/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).catch(function (e) {
            console.error('[quiz-engine] submit failed:', e && e.message ? e.message : e);
            return { ok: false, error: String(e) };
        });
    };

    // Libère le sampler Tone.js pour éviter le leak mémoire entre sessions.
    // Doit être appelé avant reload / nav out (cf. quiz-play.html beforeunload).
    QuizEngine.prototype.dispose = function () {
        if (this.sampler) {
            try {
                this.sampler.dispose();
            } catch (e) {
                console.warn('[QuizEngine] sampler dispose error:', e && e.message ? e.message : e);
            }
            this.sampler = null;
        }
        this.samplerReady = false;
    };

    // ─── Exposition globale ─────────────────────────────────────
    window.QuizEngine = QuizEngine;
    window.QUIZ_DATA = QUIZ_DATA;
    window.noteToFr = noteToFr;
})();
