// ─── Eleve guard (vanilla JS, à inclure via <script> dans chaque page outil)
//
// Expose window.requireValidEleve(slug) → Promise<boolean>.
//   - true si la session élève (GET /api/auth/whoami) porte ce slug,
//     ou si l'admin est connecté (GET /api/admin/check)
//   - sinon window.location.replace('/') (écran de connexion) et false
//
// La liste publique /api/eleves ne suffit plus : sans session, les API
// élève répondent 401/403 de toute façon.
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

  async function getJson(url) {
    try {
      var r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  global.requireValidEleve = async function (slug) {
    var s = slug ? String(slug).toLowerCase().trim() : '';
    if (s) {
      var who = await getJson('/api/auth/whoami');
      if (who && who.ok && String(who.slug || '').toLowerCase() === s) return true;
      var admin = await getJson('/api/admin/check');
      if (admin && admin.ok) return true;
    }
    window.location.replace('/');
    return false;
  };
})(window);
