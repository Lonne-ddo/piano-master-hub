// ─── Bottom nav réutilisable pour les pages d'outils élève ─────────
// Usage : <script src="/nav-outils.js" data-active="quiz"></script>
//   data-active = quiz | grilles | metro | accords (item à highlighter)
// Le script lit le slug élève dans ?eleve=… (whitelist 4 slugs).
// Si pas de slug valide, no-op (la page hôte gère son propre redirect).
// Pas d'item "Retour" : le ← Retour du header de page suffit.
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

    // Lucide-style stroke icons, 22x22, currentColor
    var ICONS = {
        quiz:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        grilles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        metro:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2"/><path d="M10 2h4"/></svg>',
        accords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="1"/><line x1="7" y1="6" x2="7" y2="20"/><line x1="11" y1="6" x2="11" y2="20"/><line x1="15" y1="6" x2="15" y2="20"/><line x1="19" y1="6" x2="19" y2="20"/></svg>',
        bibli:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    };

    // 5 items : Quiz + Grilles + Métronome + Accords + Bibli tous actifs
    var ITEMS = [
        { id: 'quiz',    label: 'Quiz',      href: '/quiz' + slugQ },
        { id: 'grilles', label: 'Grilles',   href: '/grilles' + slugQ },
        { id: 'metro',   label: 'Métro',     href: '/metronome' + slugQ },
        { id: 'accords', label: 'Accords',   href: '/accords' + slugQ },
        { id: 'bibli',   label: 'Bibli',     href: '/bibli' + slugQ }
    ];

    var css = [
        '.bottom-nav{position:fixed;bottom:0;left:0;right:0;display:grid;grid-template-columns:repeat(5,1fr);padding:6px 0 calc(6px + env(safe-area-inset-bottom));background:rgba(15,15,20,0.92);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border-top:1px solid rgba(255,255,255,0.06);z-index:100;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
        '.bottom-nav a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px 4px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:11px;font-weight:500;letter-spacing:0.2px;position:relative;transition:color 0.2s ease;min-height:56px;}',
        '.bottom-nav a svg{width:22px;height:22px;display:block;flex-shrink:0;}',
        '.bottom-nav a span{display:block;line-height:1;white-space:nowrap;}',
        '.bottom-nav a.active{color:var(--v,#8B6FE8);}',
        '.bottom-nav a.active::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:28px;height:2px;background:var(--v,#8B6FE8);border-radius:0 0 2px 2px;}',
        '.bottom-nav a.soon{opacity:0.4;}',
        '.bottom-nav a.soon::after{content:"";position:absolute;top:10px;right:calc(50% - 16px);width:6px;height:6px;border-radius:50%;background:var(--v,#8B6FE8);box-shadow:0 0 6px rgba(139,111,232,0.6);}',
        'body.has-bottom-nav{padding-bottom:calc(80px + env(safe-area-inset-bottom));}',
        'body.has-bottom-nav .toast{bottom:calc(100px + env(safe-area-inset-bottom));}',
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
