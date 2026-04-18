// Proxy AssemblyAI — fallback Whisper quand Groq sature.
//
// Variable requise : ASSEMBLY_API_KEY
// Obtenir sur : https://www.assemblyai.com → Sign up gratuit → API Keys
// Ajouter dans : Cloudflare → piano-key → Settings → Environment variables
//
// AssemblyAI accepte des fichiers volumineux, gère le français nativement,
// et n'a pas de restriction de langue mixte.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (request.headers.get('x-admin-secret') !== env.ADMIN_SECRET) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const token = env.ASSEMBLY_API_KEY?.trim();
    if (!token) {
      return new Response(JSON.stringify({ error: 'ASSEMBLY_API_KEY manquant' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) {
      return new Response(JSON.stringify({ error: 'Fichier manquant' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // Étape 1 : Upload du fichier vers AssemblyAI
    const arrayBuffer = await file.arrayBuffer();
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        'authorization': token,
        'content-type': 'application/octet-stream',
      },
      body: arrayBuffer
    });

    if (!uploadResp.ok) {
      const err = await uploadResp.json().catch(() => ({}));
      throw new Error('AssemblyAI upload: ' + (err.error || uploadResp.status));
    }

    const { upload_url } = await uploadResp.json();

    // Étape 2 : Lancer la transcription
    const transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'authorization': token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: upload_url,
        speech_models: ['universal-2'],
        language_code: 'fr',
        punctuate: true,
        format_text: true
      })
    });

    if (!transcriptResp.ok) {
      const err = await transcriptResp.json().catch(() => ({}));
      throw new Error('AssemblyAI transcript: ' + (err.error || transcriptResp.status));
    }

    const { id } = await transcriptResp.json();

    // Étape 3 : Polling jusqu'à completion (max 10 min)
    const maxAttempts = 120; // 120 × 5s = 10 min
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const statusResp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { 'authorization': token }
      });
      const result = await statusResp.json();

      if (result.status === 'completed') {
        return new Response(JSON.stringify({ text: result.text }), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
      if (result.status === 'error') {
        throw new Error('AssemblyAI: ' + result.error);
      }
      // status === 'processing' ou 'queued' → continuer
    }

    throw new Error('AssemblyAI: timeout après 10 minutes');

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
}
