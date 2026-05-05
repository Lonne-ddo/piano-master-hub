// ─── Eleve guard (vanilla JS, à inclure via <script> dans chaque page outil)
//
// Expose window.requireValidEleve(slug) → Promise<boolean>.
//   - Si slug absent ou invalide → window.location.replace('/') et return false
//   - Si slug valide selon /api/eleves (ou fallback hardcodé en cas de panne) → return true
//
// Source de vérité : GET /api/eleves (qui lit KV `eleves:list`). Fallback
// hardcodé sur les 4 élèves originaux pour le cas /api/eleves down (KV/DNS/etc.) :
// les anciens élèves marchent toujours en mode dégradé.
//
// Usage :
//   <script src="/assets/js/eleve-guard.js"></script>
//   <script>
//     (async function init() {
//       var slug = new URLSearchParams(location.search).get('eleve');
//       if (!(await window.requireValidEleve(slug))) return;
//       // ... reste du init
//     })();
//   </script>

(function (global) {
  'use strict';

  var FALLBACK = ['japhet', 'tara', 'dexter', 'messon'];

  global.requireValidEleve = async function (slug) {
    var s = slug ? String(slug).toLowerCase().trim() : '';
    if (!s) {
      window.location.replace('/');
      return false;
    }
    var valid = null;
    try {
      var r = await fetch('/api/eleves', { credentials: 'same-origin' });
      if (r.ok) {
        var j = await r.json();
        if (j && Array.isArray(j.eleves) && j.eleves.length) {
          valid = j.eleves.map(function (x) { return String(x).toLowerCase(); });
        }
      }
    } catch (e) { /* fallback */ }
    if (!valid) valid = FALLBACK;
    if (valid.indexOf(s) < 0) {
      window.location.replace('/');
      return false;
    }
    return true;
  };
})(window);
