// ─── POST /api/eleves/admin/seed-doc-ids ─────────────────────────
// Migration manuelle one-shot : pour chaque slug connu, écrit `doc_id`
// dans `eleve:<slug>` (créé si absent). Idempotent — peut être lancé
// plusieurs fois sans effet de bord.
//
// Garantit aussi que `eleves:list` contient bien tous les slugs
// (utile si la clé est partiellement initialisée).
//
// Auth : super-admin via cookie session (mh_session) + isAdminEmail.
// À lancer une fois après deploy, depuis la console DevTools sur /admin/
// (le cookie session est envoyé automatiquement) :
//
//   fetch('/api/eleves/admin/seed-doc-ids', {
//     method: 'POST',
//     credentials: 'same-origin'
//   }).then(r => r.json()).then(console.log)
//
// Réponse : { ok: true, results: [{ slug, status, value? }] }
//   status ∈ 'created' | 'updated' | 'unchanged' | 'error'

import { requireAdmin } from '../../_lib/session.js';

const DOC_IDS = {
  japhet: '19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM',
  messon: '1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI',
  dexter: '1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A',
  tara:   '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const results = [];
  for (const [slug, docId] of Object.entries(DOC_IDS)) {
    const key = `eleve:${slug}`;
    try {
      const existing = await env.MASTERHUB_STUDENTS.get(key, { type: 'json' });
      if (!existing) {
        const fresh = {
          id: slug,
          nom: slug.charAt(0).toUpperCase() + slug.slice(1),
          programme: 'Piano Master',
          statut: 'actif',
          doc_id: docId,
          doc_url: `https://docs.google.com/document/d/${docId}/edit`,
          _seededAt: new Date().toISOString(),
        };
        await env.MASTERHUB_STUDENTS.put(key, JSON.stringify(fresh));
        results.push({ slug, status: 'created', value: docId });
        continue;
      }
      if (existing.doc_id === docId) {
        results.push({ slug, status: 'unchanged', value: docId });
        continue;
      }
      const updated = {
        ...existing,
        doc_id: docId,
        doc_url: existing.doc_url || `https://docs.google.com/document/d/${docId}/edit`,
        _seededAt: new Date().toISOString(),
      };
      await env.MASTERHUB_STUDENTS.put(key, JSON.stringify(updated));
      results.push({ slug, status: 'updated', value: docId });
    } catch (e) {
      results.push({ slug, status: 'error', error: e?.message || '' });
    }
  }

  // S'assurer que eleves:list contient bien tous les slugs (auto-réparation)
  try {
    const listed = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    const set = new Set(Array.isArray(listed) ? listed.map(s => String(s).toLowerCase()) : []);
    let mutated = !Array.isArray(listed);
    for (const slug of Object.keys(DOC_IDS)) {
      if (!set.has(slug)) { set.add(slug); mutated = true; }
    }
    if (mutated) {
      await env.MASTERHUB_STUDENTS.put('eleves:list', JSON.stringify(Array.from(set)));
    }
  } catch (e) {
    // Non-bloquant : la liste sera réparée au prochain GET /api/eleves
  }

  return jsonResponse({ ok: true, results });
}
