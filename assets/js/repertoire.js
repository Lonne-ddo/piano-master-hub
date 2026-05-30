// ─── Répertoire élève — module partagé (dashboard + page liste) ──
// Expose window.MHRep : helpers de format + vue détail modale d'un morceau.
// Les ressources Analyse/Stems pointent vers /analyse?eleve=..&open=ID
// (analyse.html héberge le player, legacy multitrack ou analyse-player).
(function () {
  'use strict';

  var STATUT_LABEL = { en_cours: 'En cours', maitrise: 'Maîtrisé', bonus: 'Bonus' };
  var MONTHS = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ];

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = (s == null ? '' : String(s));
    return d.innerHTML;
  }
  function statutLabel(s) { return STATUT_LABEL[s] || 'En cours'; }
  function fmtDateFr(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }
  function youtubeId(url) {
    if (!url) return null;
    var m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^&]*&)*v=|embed\/|shorts\/|live\/))([\w-]{11})/i);
    return m ? m[1] : null;
  }

  function onKey(e) { if (e.key === 'Escape') closeDetail(); }

  function closeDetail() {
    var ov = document.getElementById('mh-rep-detail');
    if (ov) ov.remove();
    document.removeEventListener('keydown', onKey);
  }

  // Construit + affiche la vue détail d'un morceau.
  // eleveSlug : utilisé pour les liens /analyse?eleve=..&open=..
  function openDetail(eleveSlug, m) {
    closeDetail();
    if (!m) return;
    var res = m.resources || {};
    var parts = [];

    parts.push('<div class="mh-rep-modal" role="dialog" aria-modal="true">');
    parts.push('<div class="mh-rep-modal-head">');
    parts.push('<button type="button" class="mh-rep-back" data-rep-close>← Retour</button>');
    parts.push('<h2 class="mh-rep-modal-title">' + esc(m.titre) + '</h2>');
    parts.push('<span class="mh-rep-badge ' + esc(m.statut) + '">' + esc(statutLabel(m.statut)) + '</span>');
    parts.push('</div>');

    var sub = [];
    if (m.tonalite) sub.push(esc(m.tonalite));
    if (m.date_debut) sub.push('depuis le ' + esc(fmtDateFr(m.date_debut)));
    parts.push('<div class="mh-rep-modal-sub">' + sub.join(' · ') + '</div>');

    if (m.notes) {
      parts.push('<div class="mh-rep-section"><div class="mh-section-label">📝 Notes</div>' +
        '<div class="mh-rep-notes">' + esc(m.notes) + '</div></div>');
    }

    if (res.analyse_id) {
      parts.push('<div class="mh-rep-section"><div class="mh-section-label">🎬 Analyse</div>' +
        '<a class="mh-rep-resbtn" href="/analyse?eleve=' + encodeURIComponent(eleveSlug) +
        '&open=' + encodeURIComponent(res.analyse_id) + '">▶&nbsp; Ouvrir dans Analyse →</a></div>');
    }

    if (Array.isArray(res.stems_ids) && res.stems_ids.length) {
      var stemsHtml = res.stems_ids.map(function (sid, i) {
        return '<a class="mh-rep-resbtn" href="/analyse?eleve=' + encodeURIComponent(eleveSlug) +
          '&open=' + encodeURIComponent(sid) + '">🎚&nbsp; Piste ' + (i + 1) + ' →</a>';
      }).join('');
      parts.push('<div class="mh-rep-section"><div class="mh-section-label">🎵 Stems</div>' + stemsHtml + '</div>');
    }

    var yt = youtubeId(res.youtube_url);
    if (yt) {
      parts.push('<div class="mh-rep-section"><div class="mh-section-label">📺 YouTube</div>' +
        '<div class="mh-rep-yt"><iframe src="https://www.youtube.com/embed/' + esc(yt) +
        '" title="YouTube" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></div>');
    }

    if (res.grille_image_url) {
      parts.push('<div class="mh-rep-section"><div class="mh-section-label">🖼 Grille</div>' +
        '<img class="mh-rep-grille" src="' + esc(res.grille_image_url) + '" alt="Grille ' + esc(m.titre) + '" loading="lazy"></div>');
    }

    parts.push('</div>');

    var ov = document.createElement('div');
    ov.className = 'mh-rep-modal-overlay';
    ov.id = 'mh-rep-detail';
    ov.innerHTML = parts.join('');
    ov.addEventListener('click', function (e) {
      if (e.target === ov || (e.target.closest && e.target.closest('[data-rep-close]'))) closeDetail();
    });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
  }

  window.MHRep = {
    statutLabel: statutLabel,
    fmtDateFr: fmtDateFr,
    youtubeId: youtubeId,
    esc: esc,
    openDetail: openDetail,
    closeDetail: closeDetail,
  };
})();
