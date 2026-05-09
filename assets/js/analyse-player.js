// ─── Analyse Player — EQ 3 bandes + vitesse + présets ───────────────
// Attache un panneau de contrôles (3 sliders verticaux Bass/Mid/Treble,
// 3 boutons preset, 4 boutons vitesse) à un <video> existant. Pipeline :
//
//   <video> → MediaElementAudioSourceNode
//           → BiquadFilter lowshelf 200Hz   (Bass)
//           → BiquadFilter peaking 1000Hz Q=1 (Mid)
//           → BiquadFilter highshelf 4000Hz (Treble)
//           → AudioContext.destination
//
// API :
//   AnalysePlayer.attach(videoEl, controlsContainer, opts?)
//   AnalysePlayer.detach(videoEl)
//
// Important :
//   - AudioContext créé lazy au 1er play (autoplay policy iOS/Safari)
//   - Une seule MediaElementAudioSourceNode par <video> (track via WeakMap)
//   - detach() disconnect les nodes et close l'AudioContext

(function (global) {
  'use strict';

  var instances = new WeakMap();

  var PRESETS = {
    vocal: { bass: -3, mid:  6, treble:  2 },
    bass:  { bass:  6, mid:  0, treble: -2 },
    reset: { bass:  0, mid:  0, treble:  0 },
  };

  var SPEEDS = [0.5, 0.75, 1, 1.25];

  function fmtDb(v) {
    if (v === 0) return '0 dB';
    return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '') + ' dB';
  }

  function buildControls(state) {
    var root = document.createElement('div');
    root.className = 'ap-controls';
    root.innerHTML = [
      '<div class="ap-section ap-eq">',
        '<div class="ap-section-title">EQ</div>',
        '<div class="ap-eq-bands">',
          buildBand('bass', 'Bass'),
          buildBand('mid', 'Mid'),
          buildBand('treble', 'Treble'),
        '</div>',
        '<div class="ap-presets">',
          '<button type="button" class="ap-preset" data-preset="vocal" title="Vocal +mid">Vocal boost</button>',
          '<button type="button" class="ap-preset" data-preset="bass"  title="Bass +6 dB">Bass boost</button>',
          '<button type="button" class="ap-preset" data-preset="reset" title="Tout à 0">Reset</button>',
        '</div>',
      '</div>',
      '<div class="ap-section ap-speed">',
        '<div class="ap-section-title">Vitesse</div>',
        '<div class="ap-speed-row">',
          SPEEDS.map(function (s) {
            return '<button type="button" class="ap-speed-btn' + (s === 1 ? ' active' : '') + '" data-speed="' + s + '">' + s + '×</button>';
          }).join(''),
        '</div>',
      '</div>',
    ].join('');
    return root;
  }

  function buildBand(id, label) {
    return [
      '<div class="ap-band" data-band="' + id + '">',
        '<div class="ap-band-value" data-role="value">0 dB</div>',
        '<input type="range" class="ap-band-slider" min="-12" max="12" step="0.5" value="0" data-role="slider" aria-label="' + label + '" />',
        '<div class="ap-band-label">' + label + '</div>',
      '</div>',
    ].join('');
  }

  // Init AudioContext + chaîne BiquadFilters au 1er play.
  function ensureAudioGraph(state) {
    if (state.ctx) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) {
      console.warn('[analyse-player] AudioContext non supporté');
      return;
    }
    try {
      state.ctx = new Ctx();
      state.source = state.ctx.createMediaElementSource(state.videoEl);

      state.bass = state.ctx.createBiquadFilter();
      state.bass.type = 'lowshelf';
      state.bass.frequency.value = 200;

      state.mid = state.ctx.createBiquadFilter();
      state.mid.type = 'peaking';
      state.mid.frequency.value = 1000;
      state.mid.Q.value = 1;

      state.treble = state.ctx.createBiquadFilter();
      state.treble.type = 'highshelf';
      state.treble.frequency.value = 4000;

      state.source.connect(state.bass);
      state.bass.connect(state.mid);
      state.mid.connect(state.treble);
      state.treble.connect(state.ctx.destination);

      // Applique gains courants (au cas où l'admin a déjà tweaké les sliders avant le play)
      state.bass.gain.value = state.gains.bass;
      state.mid.gain.value = state.gains.mid;
      state.treble.gain.value = state.gains.treble;
    } catch (e) {
      console.warn('[analyse-player] Web Audio init failed:', e && e.message);
      state.ctx = null;
    }
  }

  // Snap au centre (0 dB) quand le slider est lâché proche de 0.
  function snapNearZero(v) {
    return (Math.abs(v) < 0.5) ? 0 : v;
  }

  function setGain(state, band, value) {
    state.gains[band] = value;
    if (state.ctx && state[band]) {
      state[band].gain.value = value;
    }
    var bandEl = state.controlsEl.querySelector('.ap-band[data-band="' + band + '"]');
    if (bandEl) {
      var slider = bandEl.querySelector('[data-role="slider"]');
      var valueEl = bandEl.querySelector('[data-role="value"]');
      if (slider && Number(slider.value) !== value) slider.value = String(value);
      if (valueEl) valueEl.textContent = fmtDb(value);
      bandEl.classList.toggle('boosted', value > 0.5);
      bandEl.classList.toggle('cut', value < -0.5);
    }
  }

  function applyPreset(state, presetId) {
    var p = PRESETS[presetId];
    if (!p) return;
    setGain(state, 'bass', p.bass);
    setGain(state, 'mid', p.mid);
    setGain(state, 'treble', p.treble);
  }

  function setSpeed(state, value) {
    state.speed = value;
    state.videoEl.playbackRate = value;
    var btns = state.controlsEl.querySelectorAll('.ap-speed-btn');
    btns.forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-speed')) === value);
    });
  }

  function bindEvents(state) {
    // Sliders EQ : input → live update gain ; change → snap au centre proche 0
    state.controlsEl.querySelectorAll('.ap-band').forEach(function (bandEl) {
      var band = bandEl.getAttribute('data-band');
      var slider = bandEl.querySelector('[data-role="slider"]');
      slider.addEventListener('input', function () {
        setGain(state, band, Number(slider.value));
      });
      slider.addEventListener('change', function () {
        var snapped = snapNearZero(Number(slider.value));
        if (snapped !== Number(slider.value)) setGain(state, band, snapped);
      });
      // Double-clic / dbltap → reset cette bande à 0
      slider.addEventListener('dblclick', function () { setGain(state, band, 0); });
    });

    // Boutons preset
    state.controlsEl.querySelectorAll('.ap-preset').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyPreset(state, btn.getAttribute('data-preset'));
      });
    });

    // Boutons vitesse
    state.controlsEl.querySelectorAll('.ap-speed-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setSpeed(state, Number(btn.getAttribute('data-speed')));
      });
    });

    // AudioContext lazy : au 1er play (autoplay policy)
    state._onPlay = function () {
      ensureAudioGraph(state);
      if (state.ctx && state.ctx.state === 'suspended') {
        state.ctx.resume().catch(function () {});
      }
    };
    state.videoEl.addEventListener('play', state._onPlay);
  }

  function attach(videoEl, container) {
    if (!videoEl || !container) return null;
    if (instances.has(videoEl)) return instances.get(videoEl);

    var state = {
      videoEl: videoEl,
      controlsEl: null,
      ctx: null, source: null,
      bass: null, mid: null, treble: null,
      gains: { bass: 0, mid: 0, treble: 0 },
      speed: 1,
      _onPlay: null,
    };

    state.controlsEl = buildControls(state);
    container.appendChild(state.controlsEl);

    bindEvents(state);

    // Reset video state coté speed (peut avoir été modifié par un attach précédent)
    state.videoEl.playbackRate = 1;

    instances.set(videoEl, state);
    return state;
  }

  function detach(videoEl) {
    var state = instances.get(videoEl);
    if (!state) return;

    if (state._onPlay) {
      try { state.videoEl.removeEventListener('play', state._onPlay); } catch (e) {}
    }
    try { state.source && state.source.disconnect(); } catch (e) {}
    try { state.bass && state.bass.disconnect(); } catch (e) {}
    try { state.mid && state.mid.disconnect(); } catch (e) {}
    try { state.treble && state.treble.disconnect(); } catch (e) {}
    if (state.ctx && state.ctx.state !== 'closed') {
      try { state.ctx.close(); } catch (e) {}
    }
    if (state.controlsEl && state.controlsEl.parentNode) {
      state.controlsEl.parentNode.removeChild(state.controlsEl);
    }
    try { state.videoEl.playbackRate = 1; } catch (e) {}

    instances.delete(videoEl);
  }

  global.AnalysePlayer = { attach: attach, detach: detach };
})(window);
