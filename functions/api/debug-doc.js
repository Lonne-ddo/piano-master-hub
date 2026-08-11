// ─── [TEMPORAIRE] Probe export Google Docs — audit onglets/tabs ────
// GET /api/debug-doc — gated admin (cookie mh_admin_pw).
// Fetch le doc de Tara en 3 variantes d'export (txt / md / html) et renvoie,
// pour chacune : longueur + présence/absence de chaînes témoins.
// But : savoir empiriquement si l'export contient TOUS les onglets et si la
// date de l'onglet le plus récent (17/07) apparaît quelque part.
//
// ⚠️ À SUPPRIMER dans un commit cleanup après validation de la branche A/B.

import { requireAdminPassword } from './_lib/session.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Doc de test : Tara (onglets 17/07 le + récent, 23/04, 07/05, Memo).
const TARA_DOC_ID = '1EKB8q-NeC4C3qt6xhOfS3QN27Ip4zpAU-X4-yWUIjxY';

// Chaînes témoins à chercher dans chaque export.
const PROBES = [
  '17/07', // date de l'onglet le plus récent (celle qui devrait gagner)
  '23/04',
  '07/05', // date actuellement affichée à tort par le Master Hub
  'Trouver la tonalité',
  'Accords et couleurs',
];

const FORMATS = ['txt', 'md', 'html'];

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

  const docId = new URL(request.url).searchParams.get('doc') || TARA_DOC_ID;
  const report = { docId, formats: {} };

  for (const format of FORMATS) {
    const url = `https://docs.google.com/document/d/${docId}/export?format=${format}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        report.formats[format] = { ok: false, httpStatus: res.status };
        continue;
      }
      const text = await res.text();
      const probes = {};
      for (const needle of PROBES) {
        probes[needle] = text.includes(needle);
      }
      // Renvoie aussi la liste des lignes "date-like" (JJ/MM en début de ligne)
      // pour voir quelles dates de séance survivent à l'export.
      const dateLines = [];
      const re = /^[\s#>*-]*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b.*$/gm;
      let m;
      while ((m = re.exec(text)) !== null) {
        dateLines.push(m[0].slice(0, 80).trim());
        if (dateLines.length >= 40) break;
      }
      report.formats[format] = {
        ok: true,
        httpStatus: res.status,
        contentType: res.headers.get('content-type'),
        length: text.length,
        probes,
        dateLines,
        first500: text.slice(0, 500),
        last500: text.slice(-500),
      };
    } catch (e) {
      report.formats[format] = { ok: false, error: e?.message || 'fetch_failed' };
    }
  }

  return jsonResponse(report);
}
