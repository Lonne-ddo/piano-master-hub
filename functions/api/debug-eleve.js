// ─── [TEMPORAIRE] Probe état élève — diagnostic derniere_seance ────
// GET /api/debug-eleve?slug=tara — gated admin (cookie mh_admin_pw).
// LECTURE SEULE. Renvoie, pour l'élève :
//   - eleve:<slug>.derniere_seance = { date, titre, manualEdit }
//   - selectLatestSession(docText) sur son doc = { date, headingRaw, error }
// But : savoir si le résumé est verrouillé (manualEdit) ou si le sync n'a pas
// re-tourné depuis le fix de sélection déterministe.
//
// ⚠️ À SUPPRIMER au commit cleanup avec debug-doc.js.

import { requireAdminPassword } from './_lib/session.js';
import { selectLatestSession } from './_lib/latest-session.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Fallback si KV vide (aligné sur sync.js FALLBACK_DOCS).
const FALLBACK_DOCS = {
  japhet: '19xGdQoE2k2tSFYp_MykzDL-7vxIz5HYr4DR3wRuQ3TM',
  messon: '1LovxCWAtCaJeLjBvLVsnG-jz-PGRETNfdm8C4BZRqJI',
  dexter: '1Ik6W8bSfwBxUMZhzS7NmDhREPq3xlbsr5ihFnva-D7A',
  tara:   '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!(await requireAdminPassword(request, env))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const slug = (new URL(request.url).searchParams.get('slug') || 'tara').toLowerCase();

  // 1. Record KV
  let eleve = null;
  try {
    eleve = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' });
  } catch (e) {
    return jsonResponse({ slug, error: `KV read failed: ${e?.message || e}` }, 500);
  }

  const ds = eleve?.derniere_seance || null;
  const derniere_seance = ds
    ? { date: ds.date ?? null, titre: ds.titre ?? null, manualEdit: ds.manualEdit ?? null }
    : null;

  // 2. selectLatestSession sur le doc courant (export txt, comme sync.js)
  const docId = eleve?.doc_id || FALLBACK_DOCS[slug] || null;
  let latest = { error: 'no_doc_id' };
  let docFetch = { docId, ok: false };
  if (docId) {
    try {
      const res = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
      docFetch = { docId, ok: res.ok, httpStatus: res.status };
      if (res.ok) {
        const docText = await res.text();
        docFetch.length = docText.length;
        const sel = selectLatestSession(docText);
        latest = { date: sel.date, headingRaw: sel.headingRaw, error: sel.error };
      }
    } catch (e) {
      docFetch.error = e?.message || 'fetch_failed';
    }
  }

  return jsonResponse({
    slug,
    kv_present: !!eleve,
    derniere_seance,
    doc_id_source: eleve?.doc_id ? 'kv' : (FALLBACK_DOCS[slug] ? 'fallback' : 'none'),
    docFetch,
    selectLatestSession: latest,
    _syncedAt: eleve?._syncedAt || null,
  });
}
