// ─── /api/mcp/:token — connecteur MCP pour claude.ai ─────────────
// Circuit « transcription → chat Claude → Master Hub » : depuis un chat
// claude.ai, le coach publie le compte rendu d'une séance directement
// dans l'historique de l'élève (même logique que le formulaire post-séance,
// cf. _lib/save-seance.js).
//
// Protocole : MCP Streamable HTTP, JSON-RPC 2.0 en POST, réponses JSON
// simples (pas de SSE). Méthodes : initialize, notifications/initialized,
// ping, tools/list, tools/call. GET (flux SSE serveur) → 405.
//
// Auth : le segment :token de l'URL est comparé à env.MCP_SECRET (temps
// constant). Token faux ou MCP_SECRET absent → 404 (l'endpoint n'existe pas).
// URL à déclarer dans claude.ai (Paramètres → Connecteurs → ajouter un
// connecteur personnalisé) : https://<domaine>/api/mcp/<MCP_SECRET>
//
// Variables d'environnement (Cloudflare Pages → Settings → Variables) :
//   MASTERHUB_STUDENTS  binding KV (élèves, séances)
//   MCP_SECRET          secret du connecteur (chaîne longue et aléatoire,
//                       ex. 48+ caractères base64url). Ne jamais commiter.
//
// Outils :
//   list_students                       → [{ slug, nom }]
//   list_sessions(slug)                 → historique des séances (récent d'abord)
//   publish_session(slug, date, titre, resume[], devoirs[], livrable?, note_coach?)

import { saveSeance, readSeances, SEANCE_LIMITS, SLUG_RE } from '../_lib/save-seance.js';

const SERVER_INFO = { name: 'master-hub', title: 'Master Hub', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 256 * 1024;

// ── Auth ──
async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

// Compare les empreintes SHA-256 (longueur fixe) octet par octet sans
// court-circuit : ni le contenu ni la longueur du secret ne fuient.
async function tokenMatches(token, secret) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof token !== 'string') return false;
  const [a, b] = await Promise.all([sha256(token), sha256(secret)]);
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

function notFound() {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── JSON-RPC ──
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ── Outils ──
const TOOLS = [
  {
    name: 'list_students',
    title: 'Lister les élèves',
    description:
      "Liste les élèves de Master Hub (slug et nom). Le slug est l'identifiant à passer aux autres outils. "
      + "À appeler en premier pour retrouver le slug de l'élève dont parle la transcription.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_sessions',
    title: "Historique des séances d'un élève",
    description:
      "Renvoie l'historique des séances déjà publiées pour un élève, de la plus récente à la plus ancienne "
      + '(date, numéro dans le parcours, titre, résumé, devoirs, livrable, note coach). '
      + "À appeler AVANT publish_session pour vérifier que la séance n'a pas déjà été publiée (même date, "
      + 'même contenu) et éviter un doublon.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "Slug de l'élève (voir list_students), ex. « japhet »." },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'publish_session',
    title: 'Publier une séance',
    description:
      "Publie le compte rendu d'une séance sur l'espace de l'élève dans Master Hub. Effets : la séance est "
      + "ajoutée à l'historique (jamais écrasée), la séance courante du parcours de 8 séances passe à "
      + "« faite », le compteur de cours est mis à jour, et les devoirs s'affichent sur l'accueil de l'élève. "
      + "L'élève voit tout sauf note_coach. Vérifier d'abord avec list_sessions qu'elle n'existe pas déjà, "
      + "et faire valider le contenu par le coach avant de publier. Rédiger au tutoiement, en s'adressant à "
      + `l'élève. Limites : titre ${SEANCE_LIMITS.titre} caractères ; ${SEANCE_LIMITS.items} puces max par liste, `
      + `${SEANCE_LIMITS.item} caractères max par puce ; livrable ${SEANCE_LIMITS.livrable} caractères ; `
      + `note_coach ${SEANCE_LIMITS.note_coach} caractères (le surplus est tronqué).`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "Slug de l'élève (voir list_students)." },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date de la séance, format YYYY-MM-DD.' },
        titre: { type: 'string', maxLength: SEANCE_LIMITS.titre, description: 'Titre court de la séance, ex. « Renversements et enchaînements ».' },
        resume: {
          type: 'array', maxItems: SEANCE_LIMITS.items,
          items: { type: 'string', maxLength: SEANCE_LIMITS.item },
          description: 'Ce qui a été vu pendant la séance, une idée par puce.',
        },
        devoirs: {
          type: 'array', maxItems: SEANCE_LIMITS.items,
          items: { type: 'string', maxLength: SEANCE_LIMITS.item },
          description: "Devoirs à préparer pour la prochaine séance, une consigne concrète par puce. Liste vide s'il n'y en a pas.",
        },
        livrable: { type: 'string', maxLength: SEANCE_LIMITS.livrable, description: "Optionnel. Ce que l'élève doit rendre ou montrer (enregistrement, morceau…)." },
        note_coach: { type: 'string', maxLength: SEANCE_LIMITS.note_coach, description: "Optionnel. Note privée pour le coach, jamais montrée à l'élève." },
      },
      required: ['slug', 'date', 'titre', 'resume', 'devoirs'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
];

function textResult(data, isError = false) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const out = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  return out;
}

function readSlug(args) {
  const slug = String(args?.slug || '').trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

async function listStudents(env) {
  const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' }).catch(() => null);
  const slugs = Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
  const records = await Promise.all(slugs.map(s =>
    env.MASTERHUB_STUDENTS.get(`eleve:${s}`, { type: 'json' }).catch(() => null)));
  return slugs.map((slug, i) => {
    const r = records[i];
    const nom = (r && (r.nom || r.name)) || slug.charAt(0).toUpperCase() + slug.slice(1);
    return { slug, nom: String(nom) };
  });
}

async function callTool(name, args, env) {
  if (name === 'list_students') {
    return textResult({ eleves: await listStudents(env) });
  }

  if (name === 'list_sessions') {
    const slug = readSlug(args);
    if (!slug) return textResult('slug invalide. Utilise list_students pour obtenir les slugs.', true);
    const record = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`, { type: 'json' }).catch(() => null);
    if (!record) return textResult(`Élève introuvable : ${slug}. Utilise list_students.`, true);
    const seances = (await readSeances(env, slug)).slice().reverse().map(s => ({
      date: s.date, n: s.n, titre: s.titre, resume: s.resume || [], devoirs: s.devoirs || [],
      livrable: s.livrable || '', note_coach: s.note_coach || '', statut: s.statut, publiee_le: s.createdAt,
    }));
    return textResult({ slug, total: seances.length, seances });
  }

  if (name === 'publish_session') {
    const slug = readSlug(args);
    if (!slug) return textResult('slug invalide. Utilise list_students pour obtenir les slugs.', true);
    const a = args || {};
    const res = await saveSeance(env, slug, {
      date: a.date, titre: a.titre, resume: a.resume, devoirs: a.devoirs,
      livrable: a.livrable, note_coach: a.note_coach,
    });
    if (!res.ok) {
      return textResult(`Publication refusée : ${res.error}${res.detail ? ` (${res.detail})` : ''}`, true);
    }
    const s = res.roadmap.seances[res.entry.n - 1];
    return textResult({
      ok: true,
      message: `Séance publiée pour ${slug} : « ${res.entry.titre} » du ${res.entry.date}.`,
      seance: {
        date: res.entry.date, n: res.entry.n, titre: res.entry.titre,
        resume: res.entry.resume, devoirs: res.entry.devoirs, livrable: res.entry.livrable,
      },
      parcours: { seance: `${s.n}/8 « ${s.titre} »`, seance_courante: res.roadmap.seance_courante },
      total_seances: res.seances.length,
    });
  }

  return null;
}

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const { id, method, params } = msg;

  if (isNotification) return null; // notifications/initialized, notifications/cancelled…

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Master Hub : espace élève d'un cours de piano. Pour publier une séance à partir d'une transcription : "
          + "1) list_students pour trouver le slug, 2) list_sessions pour éviter un doublon, 3) rédiger titre, "
          + 'résumé et devoirs, les faire valider par le coach, 4) publish_session.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      try {
        const result = await callTool(name, (params && params.arguments) || {}, env);
        if (!result) return rpcError(id, -32602, `Outil inconnu : ${name}`);
        return rpcResult(id, result);
      } catch (e) {
        return rpcResult(id, textResult(`Erreur serveur : ${e?.message || e}`, true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function onRequest({ params, request, env }) {
  if (!(await tokenMatches(params.token, env.MCP_SECRET))) return notFound();

  if (request.method !== 'POST') {
    // Pas de flux SSE serveur ni de session à fermer.
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Requête trop volumineuse'), 413);
  let body;
  try { body = JSON.parse(raw); }
  catch { return json(rpcError(null, -32700, 'Parse error'), 400); }

  // Lots JSON-RPC (protocole 2025-03-26) acceptés.
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, -32600, 'Invalid Request'), 400);
    const out = (await Promise.all(body.map(m => handleMessage(m, env)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }

  const out = await handleMessage(body, env);
  return out ? json(out) : new Response(null, { status: 202 });
}
