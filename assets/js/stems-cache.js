// ─── StemsCache ────────────────────────────────────────────────────
// Cache IndexedDB local pour les blobs audio + peaks waveforms des stems
// Demucs. Évite de re-télécharger les ~30 Mo à chaque réouverture du player.
//
// API publique (toutes méthodes async, retournent Promise) :
//   await StemsCache.init()
//   await StemsCache.getAudio(separationId, stem)   → Blob | null
//   await StemsCache.setAudio(separationId, stem, blob)
//   await StemsCache.getPeaks(separationId, stem)   → number[] | null
//   await StemsCache.setPeaks(separationId, stem, peaks)
//   await StemsCache.deleteSeparation(separationId) → vide les 6 stems d'une sépa
//   await StemsCache.clear()                        → vide tout
//   await StemsCache.size()                         → bytes total (approx)
//
// Conception :
//   - DB 'master-hub-stems' v1, 2 object stores : 'audio' (Blob), 'peaks' (Array)
//   - Key composée : `${separationId}:${stem}` (string)
//   - Fallback silencieux : si IndexedDB indispo (mode privé Firefox, quota),
//     les méthodes get/set retournent null/no-op et le code appelant fall back
//     sur le réseau. Aucune erreur visible côté UX.

(function (global) {
  'use strict';

  const DB_NAME = 'master-hub-stems';
  const DB_VERSION = 1;
  const STORE_AUDIO = 'audio';
  const STORE_PEAKS = 'peaks';

  let _dbPromise = null;
  let _disabled = false;

  function logErr(label, err) {
    if (err) console.warn('[StemsCache] ' + label, err?.message || err);
  }

  // Promesse partagée — on n'ouvre la DB qu'une seule fois.
  function openDb() {
    if (_disabled) return Promise.resolve(null);
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') {
        _disabled = true;
        return resolve(null);
      }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) {
        logErr('open() throw', e);
        _disabled = true;
        return resolve(null);
      }
      req.onupgradeneeded = function (ev) {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO);
        if (!db.objectStoreNames.contains(STORE_PEAKS)) db.createObjectStore(STORE_PEAKS);
      };
      req.onsuccess = function (ev) { resolve(ev.target.result); };
      req.onerror = function (ev) {
        logErr('open() error', ev.target.error);
        _disabled = true;
        resolve(null);
      };
      req.onblocked = function () {
        logErr('open() blocked', 'another tab holds an older version');
        resolve(null);
      };
    });
    return _dbPromise;
  }

  function keyFor(separationId, stem) {
    return String(separationId || '') + ':' + String(stem || '');
  }

  // Helper générique : transaction read/write sur un store, avec callback
  // qui reçoit le store et peut retourner une Promise/valeur.
  function tx(storeName, mode, action) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        let t;
        try { t = db.transaction(storeName, mode); }
        catch (e) { logErr('tx() throw', e); return resolve(null); }
        const store = t.objectStore(storeName);
        let result = null;
        try { result = action(store); }
        catch (e) { logErr('tx action throw', e); }
        t.oncomplete = function () { resolve(result); };
        t.onerror = function (ev) {
          logErr('tx error ' + storeName, ev.target.error);
          resolve(null);
        };
        t.onabort = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  // Wrapper : transforme un IDBRequest en Promise.
  function reqToPromise(req) {
    return new Promise(function (resolve) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }

  // ─── API publique ────────────────────────────────────────────────
  const StemsCache = {
    init: function () {
      return openDb().then(function (db) { return !!db; });
    },

    getAudio: function (separationId, stem) {
      const key = keyFor(separationId, stem);
      return tx(STORE_AUDIO, 'readonly', function (store) {
        return reqToPromise(store.get(key));
      }).then(function (val) {
        // Si la valeur stockée n'est pas un Blob (ancien schéma corrompu), null
        if (val instanceof Blob) return val;
        return null;
      });
    },

    setAudio: function (separationId, stem, blob) {
      if (!(blob instanceof Blob)) return Promise.resolve(false);
      const key = keyFor(separationId, stem);
      return tx(STORE_AUDIO, 'readwrite', function (store) {
        store.put(blob, key);
        return true;
      });
    },

    getPeaks: function (separationId, stem) {
      const key = keyFor(separationId, stem);
      return tx(STORE_PEAKS, 'readonly', function (store) {
        return reqToPromise(store.get(key));
      }).then(function (val) {
        return Array.isArray(val) ? val : null;
      });
    },

    setPeaks: function (separationId, stem, peaks) {
      if (!Array.isArray(peaks)) return Promise.resolve(false);
      const key = keyFor(separationId, stem);
      return tx(STORE_PEAKS, 'readwrite', function (store) {
        store.put(peaks, key);
        return true;
      });
    },

    // Supprime les 6 entrées audio + 6 entrées peaks d'une séparation donnée.
    // Pas de listing par préfixe natif en IDB → on parcourt les keys et match.
    deleteSeparation: function (separationId) {
      const prefix = String(separationId || '') + ':';
      function purgeStore(name) {
        return tx(name, 'readwrite', function (store) {
          return new Promise(function (resolve) {
            const req = store.openCursor();
            req.onsuccess = function (ev) {
              const cursor = ev.target.result;
              if (!cursor) return resolve(true);
              if (typeof cursor.key === 'string' && cursor.key.indexOf(prefix) === 0) {
                cursor.delete();
              }
              cursor.continue();
            };
            req.onerror = function () { resolve(false); };
          });
        });
      }
      return Promise.all([purgeStore(STORE_AUDIO), purgeStore(STORE_PEAKS)])
        .then(function () { return true; });
    },

    clear: function () {
      function clearStore(name) {
        return tx(name, 'readwrite', function (store) {
          store.clear();
          return true;
        });
      }
      return Promise.all([clearStore(STORE_AUDIO), clearStore(STORE_PEAKS)])
        .then(function () { return true; });
    },

    // Approximation : somme des Blob.size dans le store audio + estimation
    // peaks (4 bytes × 2000 valeurs × N entries). Pas une mesure exacte du
    // disque consommé par IndexedDB (overhead), mais ordre de grandeur.
    size: function () {
      const audioPromise = tx(STORE_AUDIO, 'readonly', function (store) {
        return new Promise(function (resolve) {
          let total = 0;
          const req = store.openCursor();
          req.onsuccess = function (ev) {
            const cursor = ev.target.result;
            if (!cursor) return resolve(total);
            const v = cursor.value;
            if (v instanceof Blob) total += v.size;
            cursor.continue();
          };
          req.onerror = function () { resolve(0); };
        });
      });
      const peaksPromise = tx(STORE_PEAKS, 'readonly', function (store) {
        return new Promise(function (resolve) {
          let count = 0;
          const req = store.openCursor();
          req.onsuccess = function (ev) {
            const cursor = ev.target.result;
            if (!cursor) return resolve(count);
            count++;
            cursor.continue();
          };
          req.onerror = function () { resolve(0); };
        });
      });
      return Promise.all([audioPromise, peaksPromise]).then(function (vals) {
        const audioBytes = vals[0] || 0;
        const peaksBytes = (vals[1] || 0) * 8000; // ~2000 floats × 4 bytes
        return audioBytes + peaksBytes;
      }).catch(function () { return 0; });
    },
  };

  global.StemsCache = StemsCache;
})(window);
