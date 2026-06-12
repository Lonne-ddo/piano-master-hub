// ─── Raccourcis clavier globaux — players audio Master Hub ─────────
// Espace        → play/pause du player actif
// ← (gauche)    → recule de 2 s dans le player actif
//
// Routing via un registre global : window.__mhActivePlayer.
// Chaque player se déclare actif (au play, ou à l'ouverture de son modal)
// et expose l'interface minimale :
//   { togglePlayPause(), seekBy(deltaSeconds), isPlaying: boolean }
//
// Le module no-op si aucun player n'est actif (window.__mhActivePlayer null) :
// dans ce cas Espace et ← gardent leur comportement natif (scroll / curseur),
// on ne fait JAMAIS preventDefault s'il n'y a pas de player à piloter.

(function () {
  'use strict';

  var SEEK_STEP_S = 2;

  // Skip si l'utilisateur est en train de saisir du texte ou de manipuler un
  // contrôle de formulaire (input/textarea/select/contenteditable) — l'espace
  // et la flèche doivent y garder leur sens natif.
  function isTypingTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    if (t.closest && t.closest('[contenteditable=""],[contenteditable="true"]')) return true;
    return false;
  }

  // Hook : si jamais une modal bloquante (hors player) pose .modal-open sur le
  // body, on laisse le clavier tranquille. Les players modaux (.mtp-modal) se
  // déclarent eux-mêmes actifs via le registre, donc ce test ne les gêne pas.
  function isBlockingModalOpen() {
    return document.body && document.body.classList.contains('modal-open');
  }

  function activePlayer() {
    var p = window.__mhActivePlayer;
    return (p && typeof p.togglePlayPause === 'function') ? p : null;
  }

  document.addEventListener('keydown', function (e) {
    // Laisse passer les combinaisons avec modificateur (Cmd+←, Alt+←, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (isBlockingModalOpen()) return;

    var isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
    var isLeft = e.key === 'ArrowLeft' || e.key === 'Left';
    if (!isSpace && !isLeft) return;

    var player = activePlayer();
    if (!player) return; // pas de player actif → comportement natif (scroll/curseur)

    e.preventDefault();

    if (isSpace) {
      if (e.repeat) return; // ignore l'auto-répétition si on maintient la barre
      try { player.togglePlayPause(); } catch (err) {}
    } else if (isLeft) {
      try { player.seekBy(-SEEK_STEP_S); } catch (err) {}
    }
  });
})();
