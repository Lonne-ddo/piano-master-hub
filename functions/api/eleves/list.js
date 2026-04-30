// ─── GET /api/eleves/list ────────────────────────────────────────
// Liste tous les élèves stockés sous clés `student:<slug>` dans
// MASTERHUB_STUDENTS. Si aucun n'existe, seed avec les 4 élèves initiaux
// (japhet, tara, dexter, messon).
//
// Auth : header x-admin-secret = env.ADMIN_SECRET (4697).
//
// Schema :
//   { slug, nom, email, date_debut, date_fin, statut: 'actif'|'archive' }
//
// Réponse : { ok: true, eleves: [...], seeded: bool }
//
// Note : ce stockage est DISTINCT du schema riche `eleve:<id>` utilisé par
// /api/eleves/[id] (parsing Google Doc + LLM). Cohabitation OK dans le même
// namespace KV.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

const ELEVES_INITIAUX = [
  { slug: 'japhet', nom: 'Japhet', email: '', date_debut: '2026-03-08', date_fin: '2026-05-08', statut: 'actif' },
  { slug: 'tara',   nom: 'Tara',   email: '', date_debut: '',           date_fin: '',           statut: 'actif' },
  { slug: 'dexter', nom: 'Dexter', email: '', date_debut: '',           date_fin: '',           statut: 'actif' },
  { slug: 'messon', nom: 'Messon', email: '', date_debut: '2026-03-22', date_fin: '2026-05-22', statut: 'actif' }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const secret = request.headers.get('x-admin-secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.MASTERHUB_STUDENTS) {
    return json({ error: 'kv_not_bound', hint: 'Bind MASTERHUB_STUDENTS dans CF Pages → Settings → Functions' }, 500);
  }

  let list;
  try {
    list = await env.MASTERHUB_STUDENTS.list({ prefix: 'student:', limit: 1000 });
  } catch (e) {
    return json({ error: 'kv_list_failed', details: e?.message || '' }, 500);
  }

  // Seed initial si aucun élève (1ère utilisation)
  if (list.keys.length === 0) {
    for (const eleve of ELEVES_INITIAUX) {
      try {
        await env.MASTERHUB_STUDENTS.put('student:' + eleve.slug, JSON.stringify(eleve));
      } catch (e) {
        console.error('[eleves/list] seed put failed', eleve.slug, e?.message || e);
      }
    }
    return json({ ok: true, eleves: ELEVES_INITIAUX, seeded: true });
  }

  // Lecture de toutes les clés existantes
  const eleves = [];
  for (const k of list.keys) {
    try {
      const raw = await env.MASTERHUB_STUDENTS.get(k.name);
      if (!raw) continue;
      const e = JSON.parse(raw);
      // Sanity : ignore les entrées sans slug (corruption éventuelle)
      if (!e || typeof e.slug !== 'string') continue;
      eleves.push(e);
    } catch (err) {
      console.error('[eleves/list] parse failed', k.name, err?.message || err);
    }
  }

  // Tri alphabétique par nom
  eleves.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr'));

  return json({ ok: true, eleves, seeded: false });
}
