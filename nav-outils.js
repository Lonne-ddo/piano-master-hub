// ─── Bottom nav réutilisable pour les pages d'outils élève ─────────
// Usage : <script src="/nav-outils.js" data-active="quiz"></script>
//   data-active = quiz | grilles | metro | accords (item à highlighter)
// Le script lit le slug élève dans ?eleve=… (whitelist 4 slugs).
// Si pas de slug valide, no-op (la page hôte gère son propre redirect).
(function () {
    var ELEVES = ['japhet', 'tara', 'dexter', 'messon'];

    var params = new URLSearchParams(window.location.search);
    var slugRaw = params.get('eleve');
    var slug = slugRaw ? slugRaw.toLowerCase() : null;
    if (!slug || ELEVES.indexOf(slug) < 0) return;

    var script = document.currentScript;
    if (!script) {
        var scripts = document.getElementsByTagName('script');
        script = scripts[scripts.length - 1];
    }
    var active = (script && script.getAttribute('data-active')) || '';

    var slugQ = '?eleve=' + encodeURIComponent(slug);

    // Lucide-style stroke icons, 22x22
    var ICONS = {
        back:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
        quiz:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        grilles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        metro:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2"/><path d="M10 2h4"/></svg>',
        accords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="1"/><line x1="7" y1="6" x2="7" y2="20"/><line x1="11" y1="6" x2="11" y2="20"/><line x1="15" y1="6" x2="15" y2="20"/><line x1="19" y1="6" x2="19" y2="20"/></svg>'
    };

    // Items : 1 retour + 4 outils. Outils non encore créés → soon + redirect /outils
    var ITEMS = [
        { id: 'back',    label: 'Outils',  href: '/outils' + slugQ },
        { id: 'quiz',    label: 'Quiz',    href: '/quiz' + slugQ },
        { id: 'grilles', label: 'Grilles', href: '/outils' + slugQ, soon: true },
        { id: 'metro',   label: 'Métro',   href: '/outils' + slugQ, soon: true },
        { id: 'accords', label: 'Accords', href: '/outils' + slugQ, soon: true }
    ];

    var css = [
        '.bottom-nav{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;align-items:flex-start;padding:8px 4px calc(8px + env(safe-area-inset-bottom));background:rgba(15,15,20,0.85);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border-top:1px solid rgba(255,255,255,0.06);z-index:100;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
        '.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:11px;font-weight:500;transition:color 0.2s;position:relative;min-width:0;min-height:48px;justify-content:center;}',
        '.bottom-nav a svg{width:22px;height:22px;display:block;}',
        '.bottom-nav a:hover{color:rgba(255,255,255,0.85);}',
        '.bottom-nav a.active{color:var(--v,#8B6FE8);}',
        '.bottom-nav a.active::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:24px;height:2px;background:var(--v,#8B6FE8);border-radius:0 0 2px 2px;}',
        '.bottom-nav a.soon::after{content:"bientôt";position:absolute;top:4px;right:6px;font-size:8px;padding:1px 4px;border-radius:4px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.4);font-weight:600;letter-spacing:0.02em;}',
        'body.has-bottom-nav{padding-bottom:calc(76px + env(safe-area-inset-bottom));}',
        'body.has-bottom-nav .toast{bottom:calc(96px + env(safe-area-inset-bottom));}',
        '@media (min-width:768px){.bottom-nav{display:none;}body.has-bottom-nav{padding-bottom:0;}body.has-bottom-nav .toast{bottom:32px;}}'
    ].join('');

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var html = '<nav class="bottom-nav" role="navigation" aria-label="Outils élève">';
    ITEMS.forEach(function (item) {
        var classes = [];
        if (item.id === active) classes.push('active');
        if (item.soon) classes.push('soon');
        var classAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
        var aria = item.id === active ? ' aria-current="page"' : '';
        html +=
            '<a href="' + item.href + '"' + classAttr + aria + '>' +
                ICONS[item.id] +
                '<span>' + item.label + '</span>' +
            '</a>';
    });
    html += '</nav>';

    function inject() {
        document.body.classList.add('has-bottom-nav');
        document.body.insertAdjacentHTML('beforeend', html);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
