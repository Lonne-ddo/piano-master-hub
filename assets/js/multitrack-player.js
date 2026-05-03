// ─── MultitrackPlayer ─────────────────────────────────────────────
// Composant vanilla JS — player multipiste type Moises pour 6 stems Demucs.
//
// API publique :
//   const player = new MultitrackPlayer({
//     container: document.body,
//     title: "Isn't She Lovely",
//     tracks: [
//       { id: 'vocals', label: 'Chant', color: '#A78BFA',
//         url: '/api/stems/<id>/audio/vocals' },
//       ...
//     ],
//     waveforms: { vocals: [0.1, 0.5, ...], ... } | null,
//     readOnly: false,                      // côté admin = false, élève = true
//     onWaveformsCalculated: (peaks) => {}, // POST cache R2
//   });
//   player.open();   // affiche en modal
//   player.destroy();
//
// Web Audio : 1 AudioContext + 6 MediaElementAudioSource + 6 GainNode →
// destination. Mute = gain 0, Solo = couper les autres, Volume = gain 0..1.5.
//
// Sync : tous les <audio> sont play()/pause() en parallèle ; un drift > 30 ms
// déclenche un re-align via audio.currentTime = master.currentTime.
//
// Waveforms : si peaks fournis → rendu immédiat. Sinon → décode l'audio via
// fetch + decodeAudioData → downsample à 2000 valeurs → cache via callback.

(function (global) {
  'use strict';

  const PEAK_RESOLUTION = 2000;
  const DRIFT_TOLERANCE_S = 0.03; // 30 ms
  const STEM_KEYS = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'];

  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // Downsample une Float32Array (channel data) à PEAK_RESOLUTION valeurs
  // normalisées dans [0,1] représentant la magnitude max sur chaque bucket.
  function computePeaks(channelData, resolution) {
    const len = channelData.length;
    const bucketSize = Math.max(1, Math.floor(len / resolution));
    const peaks = new Array(resolution);
    let max = 0;
    for (let i = 0; i < resolution; i++) {
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, len);
      let bucketMax = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(channelData[j]);
        if (v > bucketMax) bucketMax = v;
      }
      peaks[i] = bucketMax;
      if (bucketMax > max) max = bucketMax;
    }
    // Normalisation : si max trop bas, on évite division par zéro.
    if (max > 0.001) {
      for (let i = 0; i < resolution; i++) peaks[i] = peaks[i] / max;
    }
    // Arrondi 3 décimales (compat avec validation côté serveur)
    for (let i = 0; i < resolution; i++) {
      peaks[i] = Math.round(peaks[i] * 1000) / 1000;
    }
    return peaks;
  }

  function MultitrackPlayer(opts) {
    this.opts = opts || {};
    this.tracks = (opts.tracks || []).slice();
    this.title = opts.title || '';
    this.readOnly = !!opts.readOnly;
    this.waveformsCache = opts.waveforms || null;
    this.onWaveformsCalculated = opts.onWaveformsCalculated || null;

    this.audioCtx = null;
    this.audioEls = {};       // stem → HTMLAudioElement
    this.gainNodes = {};      // stem → GainNode
    this.canvases = {};       // stem → HTMLCanvasElement
    this.peaks = {};          // stem → number[]
    this.volumes = {};        // stem → 0..1.5 (default 1)
    this.mutedSet = new Set();
    this.soloedStem = null;

    this.modal = null;
    this.duration = 0;
    this.isPlaying = false;
    this.rafId = null;
    this.peaksPostedToServer = false;
    this._destroyed = false;

    // Pré-modal : overlay fullscreen + container off-screen pour les <audio>.
    // On charge tout (buffers audio + peaks) AVANT de monter le modal pour
    // qu'il apparaisse avec waveforms dessinés et play prêt — zéro lag perçu.
    this._preloadOverlay = null;
    this._preloadHost = null;
    this._preloadTimeoutId = null;
  }

  // Open async : overlay → preload all → build modal → render → hide overlay.
  // Si timeout 30s, on ouvre quand même (le player continuera à charger lazy).
  MultitrackPlayer.prototype.open = function () {
    const self = this;
    this._showPreloadOverlay();

    const PRELOAD_TIMEOUT_MS = 30000;
    let timedOut = false;
    const timeoutPromise = new Promise(function (resolve) {
      self._preloadTimeoutId = setTimeout(function () {
        timedOut = true;
        console.warn('[MultitrackPlayer] preload timeout 30s — opening modal anyway');
        resolve('timeout');
      }, PRELOAD_TIMEOUT_MS);
    });

    Promise.race([this._preloadResources(), timeoutPromise]).then(function () {
      if (self._preloadTimeoutId) {
        clearTimeout(self._preloadTimeoutId);
        self._preloadTimeoutId = null;
      }
      if (self._destroyed) return;

      // Si peaks calculés pendant le preload, alimenter le cache pour le rendu.
      if (!self.waveformsCache && Object.keys(self.peaks).length) {
        self.waveformsCache = self.peaks;
      }

      self._buildUI();
      if (self.waveformsCache) self._renderWaveformsFromCache();
      else self._renderWaveformsPlaceholders();
      self._hidePreloadOverlay();

      if (timedOut) {
        // Cas dégradé : certains audios pas encore prêts. On laisse le browser
        // continuer à streamer ; le 1er play peut laguer mais tout marche.
        console.warn('[MultitrackPlayer] modal opened in degraded mode');
      }
    });
  };

  MultitrackPlayer.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this._preloadTimeoutId) {
      clearTimeout(this._preloadTimeoutId);
      this._preloadTimeoutId = null;
    }
    Object.values(this.audioEls).forEach(function (a) {
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
    });
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try { this.audioCtx.close(); } catch (e) {}
    }
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
    if (this._preloadOverlay && this._preloadOverlay.parentNode) {
      this._preloadOverlay.parentNode.removeChild(this._preloadOverlay);
      this._preloadOverlay = null;
    }
    if (this._preloadHost && this._preloadHost.parentNode) {
      this._preloadHost.parentNode.removeChild(this._preloadHost);
      this._preloadHost = null;
    }
    document.body.style.overflow = '';
  };

  // ─── UI ───────────────────────────────────────────────────────
  MultitrackPlayer.prototype._buildUI = function () {
    const self = this;
    const root = document.createElement('div');
    root.className = 'mtp-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    // Header
    const header = document.createElement('div');
    header.className = 'mtp-header';
    const titleEl = document.createElement('div');
    titleEl.className = 'mtp-title';
    titleEl.textContent = this.title || 'Lecture multipiste';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mtp-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () { self.destroy(); });
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    // Tracks
    const tracksWrap = document.createElement('div');
    tracksWrap.className = 'mtp-tracks';
    this.tracks.forEach(function (t) {
      tracksWrap.appendChild(self._buildTrackRow(t));
    });

    // Transport
    const transport = document.createElement('div');
    transport.className = 'mtp-transport';
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'mtp-play';
    playBtn.setAttribute('aria-label', 'Lecture');
    playBtn.innerHTML = '▶';
    playBtn.title = 'Lecture (espace)';
    playBtn.addEventListener('click', function () { self._togglePlay(); });
    const timeEl = document.createElement('div');
    timeEl.className = 'mtp-time';
    timeEl.textContent = '0:00 / 0:00';
    const seekBar = document.createElement('input');
    seekBar.type = 'range';
    seekBar.className = 'mtp-seek';
    seekBar.min = '0';
    seekBar.max = '1000';
    seekBar.value = '0';
    seekBar.step = '1';
    seekBar.addEventListener('input', function () {
      if (!self.duration) return;
      const ratio = Number(seekBar.value) / 1000;
      self._seekAll(ratio * self.duration);
    });
    transport.appendChild(playBtn);
    transport.appendChild(timeEl);
    transport.appendChild(seekBar);

    root.appendChild(header);
    root.appendChild(tracksWrap);
    root.appendChild(transport);

    // Esc pour fermer
    this._onKey = function (e) {
      if (e.key === 'Escape') self.destroy();
      else if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        self._togglePlay();
      }
    };
    document.addEventListener('keydown', this._onKey);

    // Stocke refs DOM
    this.modal = root;
    this.playBtn = playBtn;
    this.timeEl = timeEl;
    this.seekBar = seekBar;

    // Mount + lock body scroll
    (this.opts.container || document.body).appendChild(root);
    document.body.style.overflow = 'hidden';
  };

  MultitrackPlayer.prototype._buildTrackRow = function (track) {
    const self = this;
    const row = document.createElement('div');
    row.className = 'mtp-track';
    row.setAttribute('data-stem', track.id);
    row.style.setProperty('--stem-color', track.color || '#888');

    // Controls col (left) — sur mobile passe en haut de la card
    const ctrls = document.createElement('div');
    ctrls.className = 'mtp-track-ctrls';

    const labelEl = document.createElement('div');
    labelEl.className = 'mtp-track-label';
    labelEl.textContent = track.label || track.id;

    const btnRow = document.createElement('div');
    btnRow.className = 'mtp-track-btns';
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button'; muteBtn.className = 'mtp-mute'; muteBtn.textContent = 'M';
    muteBtn.title = 'Mute';
    muteBtn.addEventListener('click', function () { self._toggleMute(track.id); });
    const soloBtn = document.createElement('button');
    soloBtn.type = 'button'; soloBtn.className = 'mtp-solo'; soloBtn.textContent = 'S';
    soloBtn.title = 'Solo';
    soloBtn.addEventListener('click', function () { self._toggleSolo(track.id); });
    btnRow.appendChild(muteBtn);
    btnRow.appendChild(soloBtn);

    const volWrap = document.createElement('div');
    volWrap.className = 'mtp-vol-wrap';
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.className = 'mtp-vol';
    volSlider.min = '0'; volSlider.max = '1.5'; volSlider.step = '0.01'; volSlider.value = '1';
    volSlider.title = 'Volume';
    volSlider.addEventListener('input', function () {
      self._setVolume(track.id, Number(volSlider.value));
    });
    volWrap.appendChild(volSlider);

    ctrls.appendChild(labelEl);
    ctrls.appendChild(btnRow);
    ctrls.appendChild(volWrap);

    // Waveform col (right) — canvas + overlay playhead
    const wave = document.createElement('div');
    wave.className = 'mtp-track-wave';
    const canvas = document.createElement('canvas');
    canvas.className = 'mtp-canvas';
    canvas.height = 60;
    canvas.width = 800; // resized on mount via ResizeObserver
    canvas.addEventListener('click', function (e) {
      if (!self.duration) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      self._seekAll(ratio * self.duration);
    });
    const playhead = document.createElement('div');
    playhead.className = 'mtp-playhead';
    wave.appendChild(canvas);
    wave.appendChild(playhead);

    row.appendChild(ctrls);
    row.appendChild(wave);

    // Refs DOM
    this.canvases[track.id] = canvas;
    this.volumes[track.id] = 1;
    row._refs = { row, muteBtn, soloBtn, volSlider, canvas, playhead };
    if (!this._trackRefs) this._trackRefs = {};
    this._trackRefs[track.id] = row._refs;

    return row;
  };

  // ─── Preload (overlay + audios off-screen + peaks) ────────────
  // Affiche un overlay fullscreen avec spinner pendant qu'on charge tout.
  MultitrackPlayer.prototype._showPreloadOverlay = function () {
    const overlay = document.createElement('div');
    overlay.className = 'mtp-preload-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('div');
    spinner.className = 'mtp-preload-spinner';
    const txt = document.createElement('div');
    txt.className = 'mtp-preload-text';
    txt.textContent = 'Chargement…';
    overlay.appendChild(spinner);
    overlay.appendChild(txt);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden'; // lock scroll dès l'overlay
    this._preloadOverlay = overlay;
  };

  MultitrackPlayer.prototype._hidePreloadOverlay = function () {
    if (!this._preloadOverlay) return;
    const ov = this._preloadOverlay;
    ov.classList.add('mtp-preload-hidden');
    setTimeout(function () {
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    }, 250);
    this._preloadOverlay = null;
  };

  // Charge en parallèle :
  //   - les 6 <audio> (dans un host off-screen, preload='auto', attente
  //     canplaythrough/loadeddata/error)
  //   - les 6 peaks waveforms (fetch + decodeAudioData + downsample) si pas
  //     déjà fournis via opts.waveforms
  // Retourne une Promise qui résout quand tout est prêt (ou échec individuel).
  MultitrackPlayer.prototype._preloadResources = function () {
    const self = this;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[MultitrackPlayer] Web Audio API non supportée');
      return Promise.resolve();
    }
    this.audioCtx = new Ctx();

    // Container off-screen pour les <audio>. MediaElementAudioSource exige
    // que les éléments soient dans le DOM — on les laisse ici jusqu'à destroy.
    const host = document.createElement('div');
    host.className = 'mtp-preload-host';
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;';
    document.body.appendChild(host);
    this._preloadHost = host;

    // 1) Audios : create + Web Audio graph + attente buffering
    const audioPromises = this.tracks.map(function (t) {
      return new Promise(function (resolve) {
        const audio = document.createElement('audio');
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.src = t.url;
        host.appendChild(audio);

        try {
          const source = self.audioCtx.createMediaElementSource(audio);
          const gain = self.audioCtx.createGain();
          gain.gain.value = 1;
          source.connect(gain).connect(self.audioCtx.destination);
          self.audioEls[t.id] = audio;
          self.gainNodes[t.id] = gain;
          self.volumes[t.id] = 1;
        } catch (e) {
          console.warn('[MultitrackPlayer] createMediaElementSource failed', t.id, e);
          resolve();
          return;
        }

        audio.addEventListener('loadedmetadata', function () {
          if (!self.duration && Number.isFinite(audio.duration)) {
            self.duration = audio.duration;
          }
        });
        audio.addEventListener('ended', function () {
          self._pauseAll();
          self._seekAll(0);
        });

        let resolved = false;
        function done() {
          if (resolved) return;
          resolved = true;
          resolve();
        }
        audio.addEventListener('canplaythrough', done, { once: true });
        audio.addEventListener('loadeddata', done, { once: true });
        audio.addEventListener('error', function () {
          console.warn('[MultitrackPlayer] audio load failed', t.id);
          done();
        });
      });
    });

    // 2) Peaks waveforms en parallèle (skip si déjà fournis via cache R2)
    let peaksPromise = Promise.resolve();
    if (!this.waveformsCache) {
      peaksPromise = Promise.all(this.tracks.map(function (t) {
        return fetch(t.url, { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
          .then(function (buf) {
            if (!buf) return null;
            return new Promise(function (res, rej) {
              self.audioCtx.decodeAudioData(buf, res, rej);
            });
          })
          .then(function (audioBuf) {
            if (!audioBuf) return null;
            const ch = audioBuf.getChannelData(0);
            const peaks = computePeaks(ch, PEAK_RESOLUTION);
            self.peaks[t.id] = peaks;
            return { id: t.id, peaks: peaks };
          })
          .catch(function (e) {
            console.warn('[MultitrackPlayer] peaks calc failed', t.id, e?.message);
            return null;
          });
      })).then(function (results) {
        // POST cache R2 une fois tous calculés (callback fourni par l'appelant)
        const allPeaks = {};
        let count = 0;
        results.forEach(function (r) {
          if (r && Array.isArray(r.peaks)) { allPeaks[r.id] = r.peaks; count++; }
        });
        if (count >= 1 && self.onWaveformsCalculated && !self.peaksPostedToServer) {
          self.peaksPostedToServer = true;
          try { self.onWaveformsCalculated(allPeaks); } catch (e) {}
        }
      });
    }

    return Promise.all([Promise.all(audioPromises), peaksPromise]);
  };

  MultitrackPlayer.prototype._togglePlay = function () {
    if (this.isPlaying) this._pauseAll();
    else this._playAll();
  };

  MultitrackPlayer.prototype._playAll = function () {
    const self = this;
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(function () {});
    }
    Object.values(this.audioEls).forEach(function (a) {
      a.play().catch(function (e) {
        console.warn('[MultitrackPlayer] play() rejected', e?.message);
      });
    });
    this.isPlaying = true;
    this.playBtn.innerHTML = '⏸';
    this._startRaf();
  };

  MultitrackPlayer.prototype._pauseAll = function () {
    Object.values(this.audioEls).forEach(function (a) { try { a.pause(); } catch (e) {} });
    this.isPlaying = false;
    this.playBtn.innerHTML = '▶';
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  };

  MultitrackPlayer.prototype._seekAll = function (timeS) {
    if (!this.duration) return;
    const t = Math.max(0, Math.min(timeS, this.duration));
    Object.values(this.audioEls).forEach(function (a) {
      try { a.currentTime = t; } catch (e) {}
    });
    this._renderTime();
    this._renderPlayhead();
  };

  MultitrackPlayer.prototype._startRaf = function () {
    const self = this;
    function tick() {
      if (!self.isPlaying || self._destroyed) return;
      self._syncDriftCheck();
      self._renderTime();
      self._renderPlayhead();
      self.rafId = requestAnimationFrame(tick);
    }
    this.rafId = requestAnimationFrame(tick);
  };

  // Si une piste dérive de plus de DRIFT_TOLERANCE_S, on la re-aligne sur
  // la piste master (premier <audio> stable).
  MultitrackPlayer.prototype._syncDriftCheck = function () {
    const ids = Object.keys(this.audioEls);
    if (!ids.length) return;
    const masterId = ids[0];
    const master = this.audioEls[masterId];
    if (!master) return;
    const masterTime = master.currentTime;
    for (let i = 1; i < ids.length; i++) {
      const other = this.audioEls[ids[i]];
      if (!other || other.paused) continue;
      if (Math.abs(other.currentTime - masterTime) > DRIFT_TOLERANCE_S) {
        try { other.currentTime = masterTime; } catch (e) {}
      }
    }
  };

  MultitrackPlayer.prototype._currentTime = function () {
    const ids = Object.keys(this.audioEls);
    if (!ids.length) return 0;
    return this.audioEls[ids[0]].currentTime || 0;
  };

  MultitrackPlayer.prototype._renderTime = function () {
    const t = this._currentTime();
    const d = this.duration;
    this.timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(d);
    if (d > 0) {
      const ratio = Math.min(1, t / d);
      this.seekBar.value = String(Math.round(ratio * 1000));
    }
  };

  MultitrackPlayer.prototype._renderPlayhead = function () {
    const self = this;
    if (!this.duration) return;
    const ratio = Math.min(1, this._currentTime() / this.duration);
    Object.keys(this._trackRefs || {}).forEach(function (id) {
      const ph = self._trackRefs[id].playhead;
      if (ph) ph.style.left = (ratio * 100) + '%';
    });
  };

  // ─── Mute / Solo / Volume ─────────────────────────────────────
  MultitrackPlayer.prototype._toggleMute = function (stem) {
    const refs = this._trackRefs[stem];
    if (this.mutedSet.has(stem)) {
      this.mutedSet.delete(stem);
      refs.muteBtn.classList.remove('active');
    } else {
      this.mutedSet.add(stem);
      refs.muteBtn.classList.add('active');
    }
    this._applyGains();
  };

  MultitrackPlayer.prototype._toggleSolo = function (stem) {
    const self = this;
    if (this.soloedStem === stem) {
      // Désactive le solo
      const refs = this._trackRefs[stem];
      refs.soloBtn.classList.remove('active');
      this.soloedStem = null;
    } else {
      // Active le solo (et désactive l'ancien)
      Object.keys(this._trackRefs).forEach(function (id) {
        self._trackRefs[id].soloBtn.classList.remove('active');
      });
      this._trackRefs[stem].soloBtn.classList.add('active');
      this.soloedStem = stem;
    }
    this._applyGains();
  };

  MultitrackPlayer.prototype._setVolume = function (stem, val) {
    this.volumes[stem] = val;
    this._applyGains();
  };

  MultitrackPlayer.prototype._applyGains = function () {
    const self = this;
    const ctxTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    Object.keys(this.gainNodes).forEach(function (id) {
      const g = self.gainNodes[id];
      let target;
      if (self.soloedStem && self.soloedStem !== id) target = 0;
      else if (self.mutedSet.has(id)) target = 0;
      else target = self.volumes[id];
      try { g.gain.setTargetAtTime(target, ctxTime, 0.01); }
      catch (e) { g.gain.value = target; }
    });
  };

  // ─── Waveforms ────────────────────────────────────────────────
  MultitrackPlayer.prototype._renderWaveformsFromCache = function () {
    const self = this;
    this.tracks.forEach(function (t) {
      const peaks = self.waveformsCache[t.id];
      if (Array.isArray(peaks) && peaks.length) {
        self.peaks[t.id] = peaks;
        self._drawWaveform(t.id, peaks, t.color);
      } else {
        self._drawSkeleton(t.id, t.color);
      }
    });
  };

  MultitrackPlayer.prototype._renderWaveformsPlaceholders = function () {
    const self = this;
    this.tracks.forEach(function (t) {
      self._drawSkeleton(t.id, t.color);
    });
  };

  MultitrackPlayer.prototype._drawWaveform = function (stem, peaks, color) {
    const canvas = this.canvases[stem];
    if (!canvas) return;
    // Resize canvas selon sa width réelle CSS (DPI-aware)
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
    const cssH = canvas.clientHeight || 60;
    if (canvas.width !== Math.floor(cssW * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const len = peaks.length;
    const barWidth = Math.max(1, w / len);

    ctx.fillStyle = color || '#888';
    for (let i = 0; i < len; i++) {
      const p = peaks[i] || 0;
      const barH = Math.max(1, p * h * 0.92);
      ctx.fillRect(i * barWidth, mid - barH / 2, Math.max(1, barWidth - 0.5), barH);
    }
  };

  MultitrackPlayer.prototype._drawSkeleton = function (stem, color) {
    const canvas = this.canvases[stem];
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
    const cssH = canvas.clientHeight || 60;
    if (canvas.width !== Math.floor(cssW * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Ligne fine au milieu = placeholder en attendant les peaks
    ctx.fillStyle = (color || '#888') + '40';
    ctx.fillRect(0, canvas.height / 2 - 1, canvas.width, 2);
  };

  // Expose globalement
  global.MultitrackPlayer = MultitrackPlayer;
  global.MULTITRACK_STEM_KEYS = STEM_KEYS;
})(window);
