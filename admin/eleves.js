// ─── Master Hub Admin — Page Élèves (CRUD) ─────────────────────────
// IIFE qui pilote /admin/eleves.html. Lit/écrit le KV MASTERHUB_STUDENTS
// via les endpoints /api/eleves/{list,save,delete}. Auth par localStorage
// 'mh_admin' (= '4697'), envoyée en header x-admin-secret.

(function () {
    'use strict';

    // ═══ Auth ═══
    var ADMIN_SECRET = localStorage.getItem('mh_admin') || '';
    if (!ADMIN_SECRET) {
        window.location.replace('/admin/');
        return;
    }

    function authHeaders() {
        return { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET };
    }

    // ═══ State ═══
    var state = {
        eleves: [],
        filter: 'all',     // 'all' | 'actif' | 'archive'
        editingSlug: null, // slug en cours d'édition (null = création)
        loading: false,
        saving: false
    };

    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ═══ Toast ═══
    var toastTimer = null;
    function showToast(msg, type) {
        var t = $('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = 'toast show' + (type ? ' ' + type : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            t.className = 'toast';
        }, 3500);
    }

    // ═══ API calls ═══
    function fetchList() {
        state.loading = true;
        renderTable();
        return fetch('/api/eleves/list', { headers: authHeaders() })
            .then(function (res) {
                return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
            })
            .then(function (r) {
                state.loading = false;
                if (r.status === 401) {
                    showToast('Code admin invalide — re-saisis dans /admin/', 'error');
                    setTimeout(function () { window.location.replace('/admin/'); }, 1500);
                    return;
                }
                if (!r.ok || !r.data || !r.data.ok) {
                    var err = (r.data && r.data.error) || ('HTTP ' + r.status);
                    showToast('Erreur chargement : ' + err, 'error');
                    state.eleves = [];
                    renderTable();
                    return;
                }
                state.eleves = Array.isArray(r.data.eleves) ? r.data.eleves : [];
                if (r.data.seeded) {
                    showToast('4 élèves initiaux créés (seed)', 'success');
                }
                renderTable();
            })
            .catch(function (e) {
                state.loading = false;
                console.error('[eleves] list failed:', e);
                showToast('Erreur réseau : ' + (e.message || ''), 'error');
                renderTable();
            });
    }

    function saveEleve(payload) {
        state.saving = true;
        var btn = $('btn-save');
        if (btn) { btn.disabled = true; btn.textContent = '…'; }

        return fetch('/api/eleves/save', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(payload)
        })
            .then(function (res) {
                return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
            })
            .then(function (r) {
                state.saving = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
                if (r.status === 401) {
                    showToast('Code admin invalide', 'error');
                    return false;
                }
                if (!r.ok || !r.data || !r.data.ok) {
                    var err = (r.data && (r.data.detail || r.data.error)) || ('HTTP ' + r.status);
                    showFormError(err);
                    return false;
                }
                return true;
            })
            .catch(function (e) {
                state.saving = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
                console.error('[eleves] save failed:', e);
                showFormError('Erreur réseau : ' + (e.message || ''));
                return false;
            });
    }

    function deleteEleve(slug) {
        return fetch('/api/eleves/delete?slug=' + encodeURIComponent(slug), {
            method: 'DELETE',
            headers: authHeaders()
        })
            .then(function (res) {
                return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
            })
            .then(function (r) {
                if (r.status === 401) {
                    showToast('Code admin invalide', 'error');
                    return false;
                }
                if (!r.ok || !r.data || !r.data.ok) {
                    var err = (r.data && r.data.error) || ('HTTP ' + r.status);
                    showToast('Suppression échouée : ' + err, 'error');
                    return false;
                }
                return true;
            })
            .catch(function (e) {
                console.error('[eleves] delete failed:', e);
                showToast('Erreur réseau : ' + (e.message || ''), 'error');
                return false;
            });
    }

    // ═══ Render table ═══
    function renderTable() {
        var content = $('content');
        var counter = $('counter');
        if (!content || !counter) return;

        if (state.loading) {
            content.innerHTML = '<div class="loading"><div class="spinner"></div>Chargement des élèves…</div>';
            counter.textContent = 'Chargement…';
            return;
        }

        var total = state.eleves.length;
        var actifs = state.eleves.filter(function (e) { return e.statut === 'actif'; }).length;
        var archives = total - actifs;
        counter.innerHTML = '<strong>' + total + '</strong> élève' + (total > 1 ? 's' : '') +
            '<span class="stats">' + actifs + ' actif' + (actifs > 1 ? 's' : '') +
            ' · ' + archives + ' archivé' + (archives > 1 ? 's' : '') + '</span>';

        var visible = state.eleves.filter(function (e) {
            if (state.filter === 'all') return true;
            return e.statut === state.filter;
        });

        if (total === 0) {
            content.innerHTML =
                '<div class="empty-state">' +
                    '<div class="icon">👥</div>' +
                    '<div class="title">Aucun élève</div>' +
                    '<div class="sub">Crée le premier élève pour commencer à gérer les profils.</div>' +
                    '<button type="button" class="btn-add" id="btn-create-first">+ Créer le premier élève</button>' +
                '</div>';
            var btn = $('btn-create-first');
            if (btn) btn.addEventListener('click', function () { openModal(null); });
            return;
        }

        if (visible.length === 0) {
            content.innerHTML =
                '<div class="empty-state">' +
                    '<div class="icon">🔍</div>' +
                    '<div class="title">Aucun élève dans ce filtre</div>' +
                    '<div class="sub">Change le filtre ci-dessus pour voir les autres élèves.</div>' +
                '</div>';
            return;
        }

        var html =
            '<table class="eleves-table">' +
                '<thead><tr>' +
                    '<th>Nom</th>' +
                    '<th>Slug</th>' +
                    '<th class="col-email">Email</th>' +
                    '<th class="col-date-debut">Début</th>' +
                    '<th class="col-date-fin">Fin</th>' +
                    '<th>Statut</th>' +
                    '<th class="col-actions"></th>' +
                '</tr></thead>' +
                '<tbody>';

        visible.forEach(function (e) {
            var statutLabel = e.statut === 'actif' ? 'Actif' : 'Archivé';
            html +=
                '<tr data-slug="' + escapeHtml(e.slug) + '">' +
                    '<td><strong>' + escapeHtml(e.nom || '—') + '</strong></td>' +
                    '<td class="col-slug">' + escapeHtml(e.slug) + '</td>' +
                    '<td class="col-email">' + escapeHtml(e.email || '—') + '</td>' +
                    '<td class="col-date col-date-debut">' + escapeHtml(e.date_debut || '—') + '</td>' +
                    '<td class="col-date col-date-fin">' + escapeHtml(e.date_fin || '—') + '</td>' +
                    '<td><span class="statut-chip ' + escapeHtml(e.statut) + '">' + statutLabel + '</span></td>' +
                    '<td class="col-actions">' +
                        '<button type="button" class="row-action" data-action="edit" data-slug="' + escapeHtml(e.slug) + '" aria-label="Modifier">✏️ Modifier</button>' +
                        '<button type="button" class="row-action danger" data-action="delete" data-slug="' + escapeHtml(e.slug) + '" aria-label="Supprimer">🗑️</button>' +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        content.innerHTML = html;

        // Event delegation
        content.addEventListener('click', onTableClick);
    }

    // Pour éviter de re-binder à chaque render, on garde l'event sur content (re-créé)
    function onTableClick(e) {
        var btn = e.target.closest('button[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        var slug = btn.getAttribute('data-slug');
        if (action === 'edit') {
            openModal(slug);
        } else if (action === 'delete') {
            handleDelete(slug);
        }
    }

    // ═══ Modale ═══
    function openModal(slug) {
        state.editingSlug = slug;
        var title = $('modal-title');
        var sub = $('modal-sub');
        var slugInput = $('f-slug');
        var nomInput = $('f-nom');
        var emailInput = $('f-email');
        var dateDebut = $('f-date-debut');
        var dateFin = $('f-date-fin');
        var statutActif = $('f-statut-actif');
        var statutArchive = $('f-statut-archive');

        clearFormError();

        if (slug) {
            var e = state.eleves.find(function (x) { return x.slug === slug; });
            if (!e) {
                showToast('Élève introuvable', 'error');
                return;
            }
            title.textContent = 'Modifier ' + (e.nom || slug);
            sub.textContent = 'Met à jour les informations de l\'élève';
            slugInput.value = e.slug;
            slugInput.readOnly = true;
            nomInput.value = e.nom || '';
            emailInput.value = e.email || '';
            dateDebut.value = e.date_debut || '';
            dateFin.value = e.date_fin || '';
            if (e.statut === 'archive') statutArchive.checked = true;
            else statutActif.checked = true;
        } else {
            title.textContent = 'Nouvel élève';
            sub.textContent = 'Crée un nouveau profil élève';
            slugInput.value = '';
            slugInput.readOnly = false;
            nomInput.value = '';
            emailInput.value = '';
            dateDebut.value = '';
            dateFin.value = '';
            statutActif.checked = true;
        }

        $('modal-backdrop').classList.add('is-visible');
        document.body.style.overflow = 'hidden';
        // Focus 1er champ
        setTimeout(function () {
            (slug ? nomInput : slugInput).focus();
        }, 50);
    }

    function closeModal() {
        $('modal-backdrop').classList.remove('is-visible');
        document.body.style.overflow = '';
        state.editingSlug = null;
        clearFormError();
    }

    function showFormError(msg) {
        var el = $('form-error');
        if (!el) return;
        el.textContent = msg;
        el.style.display = '';
    }

    function clearFormError() {
        var el = $('form-error');
        if (!el) return;
        el.textContent = '';
        el.style.display = 'none';
    }

    function readForm() {
        return {
            slug:       String($('f-slug').value || '').trim().toLowerCase(),
            nom:        String($('f-nom').value || '').trim(),
            email:      String($('f-email').value || '').trim(),
            date_debut: String($('f-date-debut').value || '').trim(),
            date_fin:   String($('f-date-fin').value || '').trim(),
            statut:     document.querySelector('input[name="statut"]:checked').value
        };
    }

    function validateLocally(p) {
        if (!/^[a-z0-9_-]{2,30}$/.test(p.slug)) {
            return 'Slug invalide (lettres minuscules, chiffres, _ ou -, 2-30 caractères)';
        }
        if (!p.nom || p.nom.length < 2 || p.nom.length > 50) {
            return 'Nom requis (2 à 50 caractères)';
        }
        if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
            return 'Email invalide';
        }
        if (p.date_debut && !/^\d{4}-\d{2}-\d{2}$/.test(p.date_debut)) {
            return 'Date début invalide';
        }
        if (p.date_fin && !/^\d{4}-\d{2}-\d{2}$/.test(p.date_fin)) {
            return 'Date fin invalide';
        }
        if (p.statut !== 'actif' && p.statut !== 'archive') {
            return 'Statut invalide';
        }
        return null;
    }

    function handleSubmit(e) {
        e.preventDefault();
        clearFormError();
        var payload = readForm();
        var localErr = validateLocally(payload);
        if (localErr) {
            showFormError(localErr);
            return;
        }

        // Si création et slug existe déjà côté local → empêche
        if (!state.editingSlug && state.eleves.some(function (x) { return x.slug === payload.slug; })) {
            showFormError('Ce slug existe déjà — utilises-en un autre');
            return;
        }

        saveEleve(payload).then(function (ok) {
            if (!ok) return;
            var creating = !state.editingSlug;
            closeModal();
            showToast(creating ? 'Élève créé' : 'Élève mis à jour', 'success');
            fetchList();
        });
    }

    function handleDelete(slug) {
        var eleve = state.eleves.find(function (x) { return x.slug === slug; });
        if (!eleve) return;
        var ok = window.confirm('Supprimer ' + (eleve.nom || slug) + ' ?\n\nLes sessions quiz historiques sont conservées.');
        if (!ok) return;
        deleteEleve(slug).then(function (ok2) {
            if (!ok2) return;
            showToast('Élève supprimé', 'success');
            fetchList();
        });
    }

    // ═══ Filters ═══
    function setFilter(f) {
        state.filter = f;
        document.querySelectorAll('.filter-chip').forEach(function (c) {
            c.classList.toggle('active', c.getAttribute('data-filter') === f);
        });
        renderTable();
    }

    // ═══ Init ═══
    function init() {
        $('btn-add').addEventListener('click', function () { openModal(null); });
        $('btn-refresh').addEventListener('click', fetchList);
        $('btn-cancel').addEventListener('click', closeModal);
        $('eleve-form').addEventListener('submit', handleSubmit);
        $('modal-backdrop').addEventListener('click', function (e) {
            if (e.target === e.currentTarget) closeModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && $('modal-backdrop').classList.contains('is-visible')) {
                closeModal();
            }
        });
        document.querySelectorAll('.filter-chip').forEach(function (c) {
            c.addEventListener('click', function () { setFilter(c.getAttribute('data-filter')); });
        });
        // Auto-lowercase du slug à la frappe
        $('f-slug').addEventListener('input', function (e) {
            var v = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (v !== e.target.value) e.target.value = v;
        });

        fetchList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
