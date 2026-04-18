// ─────────────────────────────────────────────────────────────
// Piano Key — Navigation partagée (topbar + sidebar)
//
// Injecte la topbar et la sidebar dans chaque page.
// Chemins absolus → fonctionne depuis / et /admin/
// Badge "Admin" visible uniquement sur les pages /admin/
// État actif détecté via window.location.pathname
//
// Placé en fin de <body>, avant les autres scripts :
// le DOM est déjà parsé → pas besoin de DOMContentLoaded.
// ─────────────────────────────────────────────────────────────

(function () {

  var path    = window.location.pathname;
  var inAdmin = path.startsWith('/admin/');

  // ── Topbar ─────────────────────────────────────────────────
  var TOPBAR =
    '<!-- ══ TOPBAR ══════════════════════════════════════════════ -->\n' +
    '<header class="topbar">\n' +
    '  <div class="topbar-logo">\n' +
    '    <div class="logo-wrap">\n' +
    '      <div style="position:relative;width:30px;height:18px;background:#fff;\n' +
    '        border-radius:2px;overflow:hidden;border:1px solid rgba(180,180,180,0.2);\n' +
    '        flex-shrink:0;">\n' +
    '        <!-- 5 touches blanches -->\n' +
    '        <div style="display:flex;height:100%;">\n' +
    '          <div style="flex:1;border-right:1px solid #ccc;"></div>\n' +
    '          <div style="flex:1;border-right:1px solid #ccc;"></div>\n' +
    '          <div style="flex:1;border-right:1px solid #ccc;"></div>\n' +
    '          <div style="flex:1;border-right:1px solid #ccc;"></div>\n' +
    '          <div style="flex:1;"></div>\n' +
    '        </div>\n' +
    '        <!-- 3 touches noires : positions 1, milieu, 4 -->\n' +
    '        <div style="position:absolute;top:0;left:calc(1/5*100% - 3px);\n' +
    '          width:5px;height:11px;background:rgba(9,9,15,0.85);\n' +
    '          border-radius:0 0 2px 2px;"></div>\n' +
    '        <div style="position:absolute;top:0;left:calc(2.5/5*100% - 3px);\n' +
    '          width:5px;height:11px;background:rgba(9,9,15,0.85);\n' +
    '          border-radius:0 0 2px 2px;"></div>\n' +
    '        <div style="position:absolute;top:0;left:calc(4/5*100% - 3px);\n' +
    '          width:5px;height:11px;background:rgba(9,9,15,0.85);\n' +
    '          border-radius:0 0 2px 2px;"></div>\n' +
    '      </div>\n' +
    '      <div class="logo-name">Piano<span>Key</span></div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="topbar-spacer"></div>\n' +
    (inAdmin ? '  <span class="badge b-adm">Admin</span>\n' : '') +
    '  <div class="notation-toggle" id="notation-toggle"\n' +
    '       onclick="toggleNotation()" title="Changer la notation musicale">\n' +
    '    <span class="nt-label" id="nt-label">A</span>\n' +
    '    <div class="nt-switch">\n' +
    '      <div class="nt-thumb" id="nt-thumb"></div>\n' +
    '    </div>\n' +
    '    <span class="nt-label" id="nt-label2">Do</span>\n' +
    '  </div>\n' +
    '</header>';

  // ── Sidebar ─────────────────────────────────────────────────
  var SIDEBAR =
    '<!-- ── Sidebar ─────────────────────────────────────────── -->\n' +
    '<nav class="sidebar" aria-label="Navigation principale">\n' +
    '  <div class="sidebar-section">Espace élève</div>\n' +
    '\n' +
    '  <a class="nv" href="/index.html">\n' +
    '    <span class="nv-icon">♩</span>\n' +
    '    Grilles harmoniques\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/quiz.html">\n' +
    '    <span class="nv-icon">\n' +
    '      <svg viewBox="0 0 14 14" fill="none" width="13" height="13">\n' +
    '        <circle cx="7" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/>\n' +
    '        <path d="M2 12c0-2 2.2-3.5 5-3.5s5 1.5 5 3.5"\n' +
    '              stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>\n' +
    '      </svg>\n' +
    '    </span>\n' +
    '    Quiz musical\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/metronome.html">\n' +
    '    <span class="nv-icon">\n' +
    '      <svg viewBox="0 0 14 14" fill="none" width="13" height="13">\n' +
    '        <path d="M7 13V5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>\n' +
    '        <path d="M4 13h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>\n' +
    '        <path d="M5 2h4l-1 3H6L5 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>\n' +
    '        <path d="M7 5L10.5 2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>\n' +
    '      </svg>\n' +
    '    </span>\n' +
    '    Métronome\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/chords.html">\n' +
    '    <span class="nv-icon">♬</span>\n' +
    '    Accords\n' +
    '  </a>\n' +
    '\n' +
    '  <div class="sep" style="margin:12px 8px;"></div>\n' +
    '  <div class="sidebar-section">Admin</div>\n' +
    '\n' +
    '  <a class="nv" href="/admin.html">\n' +
    '    <span class="nv-icon">♪</span>\n' +
    '    Drum Loop\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/admin/stems.html">\n' +
    '    <span class="nv-icon">🎛️</span>\n' +
    '    Séparation de pistes\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/admin/transcripteur.html">\n' +
    '    <span class="nv-icon">\n' +
    '      <svg viewBox="0 0 14 14" fill="none" width="13" height="13">\n' +
    '        <rect x="1" y="1" width="12" height="2" rx="1" fill="currentColor" opacity=".5"/>\n' +
    '        <rect x="1" y="4.5" width="12" height="1.5" rx=".75" fill="currentColor"/>\n' +
    '        <rect x="1" y="7.5" width="9"  height="1.5" rx=".75" fill="currentColor"/>\n' +
    '        <rect x="1" y="10.5" width="7" height="1.5" rx=".75" fill="currentColor"/>\n' +
    '      </svg>\n' +
    '    </span>\n' +
    '    Transcripteur\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/admin/closing.html">\n' +
    '    <span class="nv-icon">📞</span>\n' +
    '    Analyse Closing\n' +
    '  </a>\n' +
    '\n' +
    '  <a class="nv" href="/admin/eleves.html">\n' +
    '    <span class="nv-icon">🎓</span>\n' +
    '    Élèves\n' +
    '  </a>\n' +
    '\n' +
    '  <li style="margin-top:auto;padding:16px 12px 8px;">\n' +
    '    <a class="nv" href="#" id="nav-logout" ' +
    '       style="color:var(--text2);font-size:.82rem;">\n' +
    '      ✕ Déconnexion\n' +
    '    </a>\n' +
    '  </li>\n' +
    '</nav>';

  // ── Injection ───────────────────────────────────────────────
  // 1. Topbar : premier enfant du <body>
  document.body.insertAdjacentHTML('afterbegin', TOPBAR);

  // 2. Sidebar : premier enfant du <div class="layout">
  var layout = document.querySelector('.layout');
  if (layout) {
    layout.insertAdjacentHTML('afterbegin', SIDEBAR);
  }

  // ── État actif ──────────────────────────────────────────────
  // Normalise / → /index.html
  var normPath = (path === '/' ? '/index.html' : path);

  var links = document.querySelectorAll('.nv');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (href && normPath.endsWith(href)) {
      links[i].classList.add('act');
    }
  }

  // ── Hamburger mobile ────────────────────────────────────────
  var hamburger = document.createElement('button');
  hamburger.className = 'hamburger';
  hamburger.setAttribute('aria-label', 'Menu');
  hamburger.innerHTML = '<span></span><span></span><span></span>';

  var overlay = document.createElement('div');
  overlay.className = 'sb-overlay';

  var topbar  = document.querySelector('.topbar');
  var sidebar = document.querySelector('.sidebar');

  if (topbar)  { topbar.prepend(hamburger); }
  document.body.appendChild(overlay);

  function openMenu() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    overlay.classList.add('open');
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-label', 'Fermer le menu');
  }

  function closeMenu() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-label', 'Menu');
  }

  hamburger.addEventListener('click', function () {
    sidebar && sidebar.classList.contains('open') ? closeMenu() : openMenu();
  });

  overlay.addEventListener('click', closeMenu);

  if (sidebar) {
    sidebar.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeMenu);
    });
  }

  var logoutBtn = document.getElementById('nav-logout')
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function(e) {
      e.preventDefault()
      if (window.Clerk) {
        await window.Clerk.signOut()
        window.location.href = '/login.html'
      }
    })
  }

  // if ('serviceWorker' in navigator) {
  //   window.addEventListener('load', function() {
  //     navigator.serviceWorker.register('/sw.js')
  //       .catch(function(err) {
  //         console.warn('SW non enregistré:', err)
  //       })
  //   })
  // }

  var BOTTOM_NAV =
    '<nav class="bottom-nav" id="bottom-nav">\n' +
    '  <a class="bn-item" href="/index.html" data-path="/index.html">\n' +
    '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="10" width="7" height="11" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>\n' +
    '    <span>Grilles</span>\n' +
    '  </a>\n' +
    '  <a class="bn-item" href="/quiz.html" data-path="/quiz.html">\n' +
    '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>\n' +
    '    <span>Quiz</span>\n' +
    '  </a>\n' +
    '  <a class="bn-item" href="/metronome.html" data-path="/metronome.html">\n' +
    '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="12 2 4 22 20 22"/><line x1="12" y1="10" x2="16" y2="18"/></svg>\n' +
    '    <span>Métronome</span>\n' +
    '  </a>\n' +
    '  <a class="bn-item" href="/chords.html" data-path="/chords.html">\n' +
    '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="8" width="4" height="12" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="18" y="10" width="4" height="10" rx="1"/></svg>\n' +
    '    <span>Accords</span>\n' +
    '  </a>\n' +
    '  <button class="bn-item" type="button" onclick="window._toggleAdminDrawer()">\n' +
    '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>\n' +
    '    <span>Admin</span>\n' +
    '  </button>\n' +
    '</nav>\n'
  document.body.insertAdjacentHTML('beforeend', BOTTOM_NAV)
  var bnItems = document.querySelectorAll('.bn-item')
  bnItems.forEach(function(item) {
    var p = item.getAttribute('data-path')
    if (
      path === p ||
      (p === '/index.html' && (path === '/' || path === '/index.html'))
    ) {
      item.classList.add('act')
    }
  })

  // ── Drawer admin (visible uniquement sur mobile via la bottom nav) ──
  var drawerHTML =
    '<div id="pk-admin-drawer" style="' +
      'position:fixed;bottom:0;left:0;right:0;z-index:9999;' +
      'background:#13131f;border-top:1px solid rgba(255,255,255,0.1);' +
      'border-radius:16px 16px 0 0;' +
      'padding:8px 0 80px;' +
      'transform:translateY(100%);' +
      'transition:transform .25s ease;' +
      'max-height:70vh;overflow-y:auto;' +
    '">' +
      '<div style="width:36px;height:4px;background:rgba(255,255,255,0.2);' +
        'border-radius:2px;margin:8px auto 16px;"></div>' +
      '<div style="font-size:0.7rem;font-weight:700;color:rgba(255,255,255,0.3);' +
        'letter-spacing:.1em;padding:0 20px 8px;">ADMIN</div>' +
      '<a href="/admin.html" style="display:flex;align-items:center;gap:14px;' +
        'padding:14px 20px;color:#eeeaf8;text-decoration:none;font-size:0.95rem;">' +
        '<span>♪</span> Drum Loop</a>' +
      '<a href="/admin/stems.html" style="display:flex;align-items:center;gap:14px;' +
        'padding:14px 20px;color:#eeeaf8;text-decoration:none;font-size:0.95rem;">' +
        '<span>🎛️</span> Séparation de pistes</a>' +
      '<a href="/admin/transcripteur.html" style="display:flex;align-items:center;gap:14px;' +
        'padding:14px 20px;color:#eeeaf8;text-decoration:none;font-size:0.95rem;">' +
        '<span>≡</span> Transcripteur</a>' +
      '<a href="/admin/closing.html" style="display:flex;align-items:center;gap:14px;' +
        'padding:14px 20px;color:#eeeaf8;text-decoration:none;font-size:0.95rem;">' +
        '<span>📞</span> Analyse Closing</a>' +
      '<a href="/admin/eleves.html" style="display:flex;align-items:center;gap:14px;' +
        'padding:14px 20px;color:#eeeaf8;text-decoration:none;font-size:0.95rem;">' +
        '<span>🎹</span> Élèves</a>' +
    '</div>' +
    '<div id="pk-admin-overlay" onclick="window._toggleAdminDrawer()" style="' +
      'display:none;position:fixed;inset:0;' +
      'background:rgba(0,0,0,0.6);z-index:9998;' +
    '"></div>'

  document.body.insertAdjacentHTML('beforeend', drawerHTML)

  window._toggleAdminDrawer = function() {
    var drawer = document.getElementById('pk-admin-drawer')
    var ovl    = document.getElementById('pk-admin-overlay')
    if (!drawer || !ovl) return
    var isOpen = drawer.style.transform === 'translateY(0px)' ||
                 drawer.style.transform === 'translateY(0)'
    if (isOpen) {
      drawer.style.transform = 'translateY(100%)'
      ovl.style.display = 'none'
    } else {
      ovl.style.display = 'block'
      requestAnimationFrame(function() {
        drawer.style.transform = 'translateY(0)'
      })
    }
  }

})();
