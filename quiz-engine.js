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

    // Dépend de MhTheory (mh-music-theory.js doit être chargé avant ce script).
    if (!window.MhTheory) {
        throw new Error('quiz-engine.js requires mh-music-theory.js to be loaded first');
    }
    var MT = window.MhTheory;

    // ─── Catalogues — la plupart importés depuis MhTheory, certains
    //                  spécifiques au quiz restent locaux ─────────
    var NOTES = MT.CHROMATIC_SHARP.map(function (id) {
        return { id: id, name: id };
    });

    // Mapping note → samples Tone.js (3 octaves) — spécifique au quiz audio.
    var NOTE_TONES = {
        'C':  ['C3','C4','C5'],   'C#': ['Db3','Db4','Db5'],
        'D':  ['D3','D4','D5'],   'D#': ['Eb3','Eb4','Eb5'],
        'E':  ['E3','E4','E5'],   'F':  ['F3','F4','F5'],
        'F#': ['F#3','F#4','F#5'],'G':  ['G3','G4','G5'],
        'G#': ['Ab3','Ab4','Ab5'],'A':  ['A3','A4','A5'],
        'A#': ['Bb3','Bb4','Bb5'],'B':  ['B3','B4','B5']
    };

    var INTERVAL_TYPES = MT.INTERVAL_TYPES;

    // Roots utilisés par le quiz (uniquement notes blanches → identiques en sharp/flat).
    var BASE_ROOTS_IV = ['C3','D3','E3','F3','G3','A3'];

    // Pool d'accords pour le quiz : array dérivé de MT.CHORD_TYPES (22 types).
    // Source unique de vérité = MhTheory.CHORD_TYPES (cf. mh-music-theory.js).
    var CHORD_LIST = Object.keys(MT.CHORD_TYPES).map(function (id) {
        var def = MT.CHORD_TYPES[id];
        return { id: id, name: def.name, intervals: def.intervals };
    });

    var BASE_NOTES_CH = ['C4','D4','E4','F4','G4','A4'];

    // ─── Gammes (commit 2b.2) ─────────────────────────────────────
    // Mineure naturelle uniquement (mode aeolien). Intervals incluent
    // l'octave (12) pour rendre la gamme complète à l'écoute.
    var SCALE_TYPES = [
        { id: 'major', name: 'Majeure', intervals: [0, 2, 4, 5, 7, 9, 11, 12] },
        { id: 'minor', name: 'Mineure', intervals: [0, 2, 3, 5, 7, 8, 10, 12] }
    ];

    // noteToFr est désormais MT.noteToFr (cf. mh-music-theory.js).

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
            CHORD_TYPES: CHORD_LIST,
            BASE_NOTES: BASE_NOTES_CH,
            // Filtres alignés avec MhTheory.CHORD_TYPES (convention 'min', pas 'm').
            levelFilter: {
                debutant:      ['maj','min','dim'],
                intermediaire: ['maj','min','dim','aug','7','maj7','min7','sus4'],
                avance:        ['maj','min','dim','aug','7','maj7','min7','sus2','sus4','min7b5']
            },
            levelChoices: { debutant: 3, intermediaire: 4, avance: 6 }
        },
        scales: {
            TYPES: SCALE_TYPES,
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

    // buildChordNotes / getUpperNote sont MT.notesFromIntervals / MT.getUpperNote.

    // ─── QuizEngine class ─────────────────────────────────────────
    function QuizEngine(opts) {
        opts = opts || {};
        this.mode = opts.mode;             // notes | intervals | chords | scales | progressions
        this.level = opts.level;            // debutant | intermediaire | avance | custom
        this.slug = opts.slug;
        // Custom : ids de types valides pour ce mode (ex: ['maj','min','dim'] pour chords)
        this.customTypes = Array.isArray(opts.customTypes) ? opts.customTypes.slice() : null;
        this.totalQuestions = opts.totalQuestions || 10;
        this.questions = [];
        this.cur = 0;
        this.score = 0;
        this.answered = false;
        this.replaysUsedForCurrent = 0;
        this._scheduledTimeouts = []; // setTimeout IDs pour stopper séquences (scales/progressions)
        this.startedAt = Date.now();
        this.sampler = null;
        this.samplerReady = false;
    }

    QuizEngine.prototype.init = function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            // Restaure volume sauvegardé (format % 0..100, converti en dB pour Tone)
            try {
                var savedPct = parseFloat(localStorage.getItem('masterhub_volume'));
                if (!isNaN(savedPct)) {
                    Tone.Destination.volume.value = savedPct <= 0
                        ? -Infinity
                        : 20 * Math.log10(savedPct / 100);
                }
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
            // 50/50 dièse vs bémol — cohérent dans toute la question (correct + leurres).
            // Les ids restent en sharp ('C#') côté KV/score ; seul le label affiché varie.
            var useFlat = Math.random() < 0.5;
            var displayChoices = choices.map(function (n) {
                return { id: n.id, name: MT.noteToFr(n.id, { useFlat: useFlat }) };
            });
            var displayCorrect = {
                id: correctNote.id,
                name: MT.noteToFr(correctNote.id, { useFlat: useFlat })
            };
            return {
                correct: displayCorrect,
                choices: displayChoices,
                payload: { tone: tone, useFlat: useFlat }
            };
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
            // Custom : pool = customTypes (ids) si level === 'custom' et au moins 2 types
            var poolCh;
            if (this.level === 'custom' && this.customTypes && this.customTypes.length >= 2) {
                poolCh = data.CHORD_TYPES.filter(function (c) {
                    return this.customTypes.indexOf(c.id) >= 0;
                }, this);
            } else {
                poolCh = this._filterByLevel(data.CHORD_TYPES, data.levelFilter);
            }
            var correctCh = pickRandom(poolCh);
            var rootCh = pickRandom(data.BASE_NOTES);
            // Choix : min(levelChoices, poolSize) — 6 max si custom
            var maxChoices = (this.level === 'custom') ? Math.min(6, poolCh.length) : (data.levelChoices[this.level] || 4);
            var nCC = Math.min(maxChoices, poolCh.length);
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
                payload: { tonic: tonic, tonicFr: MT.noteToFr(tonic) }
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
            // Stoppe systématiquement tout son en cours avant de jouer la
            // question suivante (clearTimeout + sampler.releaseAll). Évite
            // les chevauchements de notes lorsqu'on enchaîne les réponses
            // rapidement dans les modes notes/intervals/chords (les modes
            // scales/progressions le faisaient déjà localement avant).
            self._clearScheduled();
            if (self.mode === 'notes') {
                var dur = QUIZ_DATA.notes.duration;
                self.sampler.triggerAttackRelease(q.payload.tone, dur);
            } else if (self.mode === 'intervals') {
                var upper = MT.getUpperNote(q.payload.root, q.correct.semis);
                var now = Tone.now();
                if (q.payload.direction === 'asc') {
                    self.sampler.triggerAttackRelease(q.payload.root, '2n', now);
                    self.sampler.triggerAttackRelease(upper, '2n', now + 0.6);
                } else {
                    self.sampler.triggerAttackRelease(upper, '2n', now);
                    self.sampler.triggerAttackRelease(q.payload.root, '2n', now + 0.6);
                }
            } else if (self.mode === 'chords') {
                var notes = MT.notesFromIntervals(q.payload.root, q.correct.intervals);
                var nowCh = Tone.now();
                notes.forEach(function (n) {
                    self.sampler.triggerAttackRelease(n, '2n', nowCh);
                });
            } else if (self.mode === 'scales') {
                // Replay limit (par niveau). Note : _clearScheduled() a déjà
                // été appelé au début de playCurrent — un click "Réécouter"
                // au-delà du quota coupe le son en cours puis ne relance rien.
                var maxPlays = QUIZ_DATA.scales.REPLAY_BY_LEVEL[self.level] || 999;
                if (self.replaysUsedForCurrent >= maxPlays) return;
                self.replaysUsedForCurrent++;
                var sd = QUIZ_DATA.scales;
                var rootStr = q.payload.tonic + sd.OCTAVE;
                var dur = sd.NOTE_DURATION_S;
                var scaleNotes = MT.notesFromIntervals(rootStr, q.correct.intervals);
                scaleNotes.forEach(function (noteFull, i) {
                    var id = setTimeout(function () {
                        if (self.sampler) self.sampler.triggerAttackRelease(noteFull, dur);
                    }, i * dur * 1000);
                    self._scheduledTimeouts.push(id);
                });
            } else if (self.mode === 'progressions') {
                // _clearScheduled() déjà appelé au début de playCurrent.
                var pd = QUIZ_DATA.progressions;
                var triads = pd.TRIADS_C_MAJOR;
                var durP = pd.CHORD_DURATION_S;
                var gap = pd.GAP_S;
                q.correct.chords.forEach(function (chordId, i) {
                    var chordNotes = triads[chordId];
                    if (!chordNotes) return;
                    var id = setTimeout(function () {
                        if (!self.sampler) return;
                        chordNotes.forEach(function (n) {
                            self.sampler.triggerAttackRelease(n, durP);
                        });
                    }, i * (durP + gap) * 1000);
                    self._scheduledTimeouts.push(id);
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

    // Coupe net toute séquence audio en cours (scales/progressions) :
    // - clearTimeout sur les notes scheduled mais pas encore jouées
    // - releaseAll() sur les notes en cours de jeu
    QuizEngine.prototype._clearScheduled = function () {
        if (this._scheduledTimeouts && this._scheduledTimeouts.length) {
            this._scheduledTimeouts.forEach(function (id) { clearTimeout(id); });
            this._scheduledTimeouts = [];
        }
        if (this.sampler && typeof this.sampler.releaseAll === 'function') {
            try { this.sampler.releaseAll(); } catch (e) {}
        }
    };

    QuizEngine.prototype.next = function () {
        // Stop audio précédent avant la transition
        this._clearScheduled();
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
        this._clearScheduled();
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
