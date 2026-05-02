/**
 * Cloudflare Function — Proxy Groq Whisper
 * ═══════════════════════════════════════════════════════
 * Reçoit un chunk audio en multipart/form-data (max 24 Mo)
 * et retourne la transcription texte via Groq Whisper.
 * Clé API lue depuis env.GROQ_API_KEY (variable Cloudflare).
 */

import { requireAdmin } from "./_lib/session.js";

export const config = {
  runtime: 'edge',
};

const MODEL = "whisper-large-v3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest(context) {
  const { request, env } = context;

  // Preflight CORS
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Méthode non autorisée" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Auth super-admin (cookie session) — évite que /api/transcribe consomme le quota Groq publiquement
  if (!(await requireAdmin(request, env))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Vérification clé API
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Variable d'environnement GROQ_API_KEY manquante" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Lecture du body multipart
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ error: "Corps multipart invalide" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const file = formData.get("file");
  if (!file) {
    return new Response(JSON.stringify({ error: "Champ 'file' manquant dans le formulaire" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Préparation de la requête Groq Whisper — verbose_json pour récupérer
  // les segments avec leurs timestamps (start/end en secondes).
  const groqForm = new FormData();
  groqForm.append("file", file);
  groqForm.append("model", MODEL);
  groqForm.append("response_format", "verbose_json");
  groqForm.append("timestamp_granularities[]", "segment");
  // Prompt initial pour biaiser Whisper vers le vocabulaire musical des cours Estelon
  groqForm.append(
    "prompt",
    "Cours de piano en français avec Estelon, coach piano. Vocabulaire technique : accords (majeur, mineur, maj7, min7, min9, maj9, dim, sus2, sus4), voicings, renversements, tritons, tensions et résolutions, degrés (I II V I), gammes (majeure, mineure, harmonique, mélodique, pentatonique), tonalités, modulations, arpèges, ear training, tonedear, métronome, répertoire : Amazing Grace, Abrite-moi, Can't Help Falling in Love."
  );
  // Pas de 'language' : détection automatique (meilleur pour contenu mixte)

  // ── Réponse en streaming SSE avec heartbeats ──
  // Groq Whisper ne stream pas sa réponse (un seul JSON à la fin), donc on
  // ouvre un flux SSE côté serveur et on émet un commentaire keepalive toutes
  // les 10s pendant qu'on attend Groq. Tant que des octets circulent, la
  // gateway Cloudflare ne ferme pas la connexion (sinon : timeout 30s → 502).
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Premier octet immédiat pour amorcer la connexion côté client
      controller.enqueue(encoder.encode(": connected\n\n"));

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch {}
      }, 10000);

      // Timeout de sécurité 120s (au lieu de 25s) — Groq Whisper sur un chunk
      // de 24 Mo dépasse régulièrement 25s mais finit largement sous 120s.
      const abortCtrl = new AbortController();
      const timeoutId = setTimeout(() => abortCtrl.abort(), 120000);

      const sendEvent = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        const groqResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method:  "POST",
          headers: { "Authorization": `Bearer ${apiKey}` },
          body:    groqForm,
          signal:  abortCtrl.signal,
        });

        clearTimeout(timeoutId);

        if (!groqResp.ok) {
          const errText = await groqResp.text();
          sendEvent({ error: `Erreur Groq (${groqResp.status}) : ${errText}`, status: groqResp.status });
        } else {
          const groqData = await groqResp.json();
          sendEvent({
            text: groqData?.text ?? "",
            segments: Array.isArray(groqData?.segments)
              ? groqData.segments.map(s => ({ id: s.id, start: s.start, end: s.end, text: s.text }))
              : []
          });
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") {
          sendEvent({ error: "Timeout — fichier trop long à traiter (>120s)", status: 408 });
        } else {
          sendEvent({ error: `Erreur réseau Groq : ${err.message}`, status: 502 });
        }
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no", // désactive le buffering proxy si présent
    },
  });
}
