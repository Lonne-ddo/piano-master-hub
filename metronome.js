// ─── Master Hub — Métronome ─────────────────────────────────────────
// Web Audio API native, scheduler Chris Wilson (lookahead).
// Persistance par élève : localStorage 'mh_metro:<slug>'.
// Pré-compte 4 temps optionnel avant démarrage du scheduler principal.

(function () {
    'use strict';

    var ELEVES = ['japhet', 'tara', 'dexter', 'messon'];
    var DISPLAY = { japhet: 'Japhet', tara: 'Tara', dexter: 'Dexter', messon: 'Messon' };

    // ─── Slug + persistance ───────────────────────────────────────
    var params = new URLSearchParams(window.location.search);
    var slug = (params.get('eleve') || '').toLowerCase();
    if (!slug || ELEVES.indexOf(slug) < 0) {
        window.location.replace('/');
        return;
    }
    try { localStorage.setItem('eleve_slug', slug); } catch (e) {}

    var STORAGE_KEY = 'mh_metro:' + slug;

    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            var obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }

    function persistState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                bpm: bpm,
                signature: signature,
                soundType: soundType,
                precount: precountEnabled
            }));
        } catch (e) {}
    }

    var saved = loadState();

    // ─── État global ──────────────────────────────────────────────
    var audioCtx = null;
    var bpm = clampBpm(saved.bpm || 100);
    var signature = ([2, 3, 4].indexOf(saved.signature) >= 0) ? saved.signature : 4;
    var soundType = (['beep','wood','hihat'].indexOf(saved.soundType) >= 0) ? saved.soundType : 'beep';
    var precountEnabled = !!saved.precount;
    var isRunning = false;
    var currentBeat = 0;
    var nextNoteTime = 0.0;
    var schedulerTimer = null;
    var tapTimes = [];
    var penduleSide = 1;
    var precountTimers = [];

    var LOOKAHEAD = 25.0;     // ms
    var SCHEDULE_AHEAD = 0.1; // secondes

    function clampBpm(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) return 100;
        return Math.min(220, Math.max(40, n));
    }

    // ─── Header (élève display) ───────────────────────────────────
    var subtitle = document.getElementById('page-subtitle');
    if (subtitle && DISPLAY[slug]) subtitle.textContent = 'Pour ' + DISPLAY[slug];
    var backLink = document.getElementById('back-link');
    if (backLink) backLink.href = '/outils?eleve=' + encodeURIComponent(slug);

    // ─── Scheduler (Chris Wilson) ─────────────────────────────────
    function scheduler() {
        while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
            scheduleNote(currentBeat, nextNoteTime);
            var delay = Math.max(0, (nextNoteTime - audioCtx.currentTime) * 1000);
            var beat = currentBeat;
            setTimeout(function () {
                updateBeats(beat);
                swingPendulum(beat);
            }, delay);
            nextNoteTime += 60.0 / bpm;
            currentBeat = (currentBeat + 1) % signature;
        }
    }

    function scheduleNote(beat, time) {
        playSound(time, beat === 0);
    }

    // ─── Sons synthétisés (Web Audio) ─────────────────────────────
    function playSound(time, isAccent) {
        var ctx = audioCtx;
        if (!ctx) return;
        var gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.8 * (isAccent ? 1.0 : 0.55), time);

        if (soundType === 'beep') {
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(isAccent ? 880 : 660, time);
            osc.connect(gain);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
            osc.start(time);
            osc.stop(time + 0.08);
        } else if (soundType === 'wood') {
            var osc2 = ctx.createOscillator();
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(isAccent ? 800 : 600, time);
            osc2.connect(gain);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
            osc2.start(time);
            osc2.stop(time + 0.05);
        } else if (soundType === 'hihat') {
            var size = Math.floor(ctx.sampleRate * 0.05);
            var buf = ctx.createBuffer(1, size, ctx.sampleRate);
            var d = buf.getChannelData(0);
            for (var i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
            var src = ctx.createBufferSource();
            src.buffer = buf;
            var hpf = ctx.createBiquadFilter();
            hpf.type = 'highpass';
            hpf.frequency.value = 7000;
            src.connect(hpf);
            hpf.connect(gain);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
            src.start(time);
        }
    }

    // ─── Pendule SVG ──────────────────────────────────────────────
    function swingPendulum() {
        penduleSide *= -1;
        var angle = penduleSide * 30;
        var rad = angle * Math.PI / 180;
        var x2 = 60 + Math.sin(rad) * 80;
        var y2 = 10 + Math.cos(rad) * 80;
        var rod = document.getElementById('metro-rod');
        var bob = document.getElementById('metro-bob');
        if (rod) { rod.setAttribute('x2', x2.toFixed(1)); rod.setAttribute('y2', y2.toFixed(1)); }
        if (bob) { bob.setAttribute('cx', x2.toFixed(1)); bob.setAttribute('cy', y2.toFixed(1)); }
    }

    function resetPendulum() {
        var rod = document.getElementById('metro-rod');
        var bob = document.getElementById('metro-bob');
        if (rod) { rod.setAttribute('x2', '60'); rod.setAttribute('y2', '90'); }
        if (bob) { bob.setAttribute('cx', '60'); bob.setAttribute('cy', '90'); }
    }

    // ─── Beats visuels ────────────────────────────────────────────
    function renderBeats() {
        var c = document.getElementById('metro-beats');
        if (!c) return;
        c.innerHTML = '';
        for (var i = 0; i < signature; i++) {
            var box = document.createElement('div');
            box.className = 'metro-beat-box' + (i === 0 ? ' accent' : '');
            box.id = 'beat-' + i;
            c.appendChild(box);
        }
    }

    function updateBeats(beatIndex) {
        document.querySelectorAll('.metro-beat-box').forEach(function (el, i) {
            el.classList.toggle('active', i === beatIndex);
        });
    }

    function clearBeats() {
        document.querySelectorAll('.metro-beat-box').forEach(function (el) {
            el.classList.remove('active');
        });
    }

    // ─── Start / Stop ─────────────────────────────────────────────
    function ensureCtx() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }

    function clearPrecountTimers() {
        precountTimers.forEach(function (id) { clearTimeout(id); });
        precountTimers = [];
        var overlay = document.getElementById('metro-precount');
        if (overlay) overlay.classList.remove('show');
    }

    function startMain() {
        currentBeat = 0;
        penduleSide = -1;
        nextNoteTime = audioCtx.currentTime + 0.05;
        schedulerTimer = setInterval(scheduler, LOOKAHEAD);
        isRunning = true;
        var btn = document.getElementById('metro-startstop');
        if (btn) {
            btn.textContent = '■ Stop';
            btn.classList.add('is-stop');
        }
    }

    function startWithPrecount() {
        clearPrecountTimers();
        var beatDur = 60 / bpm; // sec
        var overlay = document.getElementById('metro-precount');
        if (overlay) overlay.classList.add('show');
        // Désactive temporairement le bouton pendant le pré-compte
        var btn = document.getElementById('metro-startstop');
        if (btn) {
            btn.textContent = 'Pré-compte…';
            btn.classList.add('is-stop');
        }
        isRunning = true; // empêche un double-click

        for (var i = 0; i < 4; i++) {
            (function (idx) {
                var label = String(4 - idx); // 4, 3, 2, 1
                var t0 = idx * beatDur * 1000;
                var id = setTimeout(function () {
                    if (overlay) overlay.textContent = label;
                    var when = audioCtx.currentTime + 0.005;
                    playSound(when, idx === 0); // accent sur le premier
                }, t0);
                precountTimers.push(id);
            })(i);
        }
        // À la fin du 4ᵉ tick → start main
        var afterId = setTimeout(function () {
            clearPrecountTimers();
            startMain();
        }, 4 * beatDur * 1000);
        precountTimers.push(afterId);
    }

    function start() {
        ensureCtx();
        if (precountEnabled) {
            startWithPrecount();
        } else {
            startMain();
        }
    }

    function stop() {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
        clearPrecountTimers();
        isRunning = false;
        clearBeats();
        resetPendulum();
        var btn = document.getElementById('metro-startstop');
        if (btn) {
            btn.textContent = '▶ Lancer';
            btn.classList.remove('is-stop');
        }
    }

    // ─── Update display ───────────────────────────────────────────
    function refreshBpmDisplay() {
        var d = document.getElementById('metro-bpm-display');
        var s = document.getElementById('metro-slider');
        if (d) d.textContent = bpm;
        if (s) s.value = bpm;
    }

    function setBpm(newBpm) {
        bpm = clampBpm(newBpm);
        refreshBpmDisplay();
        persistState();
    }

    function setSignature(newSig) {
        signature = newSig;
        renderBeats();
        persistState();
        if (isRunning) { stop(); start(); }
    }

    function setSoundType(newSound) {
        soundType = newSound;
        persistState();
    }

    function setPrecount(enabled) {
        precountEnabled = !!enabled;
        persistState();
    }

    // ─── Wire up ──────────────────────────────────────────────────
    function selectInGroup(groupSelector, value) {
        document.querySelectorAll(groupSelector + ' [data-value]').forEach(function (btn) {
            btn.classList.toggle('selected', btn.getAttribute('data-value') === String(value));
        });
    }

    function init() {
        // Initial UI sync
        refreshBpmDisplay();
        renderBeats();
        selectInGroup('#metro-sig-row', signature);
        selectInGroup('#metro-sound-row', soundType);
        var precountToggle = document.getElementById('metro-precount-toggle');
        if (precountToggle) precountToggle.checked = precountEnabled;

        // BPM slider
        var slider = document.getElementById('metro-slider');
        if (slider) slider.addEventListener('input', function (e) {
            setBpm(e.target.value);
        });

        // ±1 / ±10 boutons
        document.querySelectorAll('.metro-step').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setBpm(bpm + Number(btn.getAttribute('data-delta')));
            });
        });

        // Tap tempo
        var tapBtn = document.getElementById('metro-tap');
        if (tapBtn) tapBtn.addEventListener('click', function () {
            ensureCtx();
            var now = performance.now();
            tapTimes.push(now);
            if (tapTimes.length > 4) tapTimes.shift();
            if (tapTimes.length >= 2) {
                var intervals = [];
                for (var i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
                var avg = intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length;
                setBpm(60000 / avg);
            }
        });

        // Signature buttons (4/3/2)
        document.querySelectorAll('#metro-sig-row [data-value]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var v = Number(btn.getAttribute('data-value'));
                if ([2, 3, 4].indexOf(v) < 0) return;
                selectInGroup('#metro-sig-row', v);
                setSignature(v);
            });
        });

        // Sound buttons
        document.querySelectorAll('#metro-sound-row [data-value]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var v = btn.getAttribute('data-value');
                selectInGroup('#metro-sound-row', v);
                setSoundType(v);
            });
        });

        // Pré-compte toggle
        if (precountToggle) precountToggle.addEventListener('change', function (e) {
            setPrecount(e.target.checked);
        });

        // Start / Stop
        var ssBtn = document.getElementById('metro-startstop');
        if (ssBtn) ssBtn.addEventListener('click', function () {
            if (isRunning) stop();
            else start();
        });

        // Cleanup AudioContext + persistance finale au unload
        var cleanup = function () {
            stop();
            persistState();
            if (audioCtx && audioCtx.state !== 'closed') {
                try { audioCtx.close(); } catch (e) {}
            }
        };
        window.addEventListener('beforeunload', cleanup);
        window.addEventListener('pagehide', cleanup);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
