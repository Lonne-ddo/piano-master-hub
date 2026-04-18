// Ordre de fallback : Gemini Flash → Groq → Cloudflare Workers AI

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

async function callLLM(env, systemPrompt, userMessage, opts = {}) {
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.3;
  const maxTokens   = typeof opts.max_tokens  === 'number' ? opts.max_tokens  : 600;

  // TENTATIVE 1 : Gemini Flash (contexte illimité — idéal pour longues transcriptions)
  if (env.GEMINI_API_KEY) {
    try {
      const gemResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY?.trim()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage }]
            }],
            generationConfig: { maxOutputTokens: maxTokens, temperature }
          })
        }
      );
      const gemData = await gemResp.json();
      const text = gemData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (gemResp.ok && text) {
        return { text, provider: 'gemini' };
      }
      console.error('Gemini error:', gemResp.status, JSON.stringify(gemData).substring(0, 200));
    } catch (e) {
      console.error('Gemini exception:', e.message);
    }
  }

  // TENTATIVE 2 : Groq (bon pour textes courts < 6000 tokens)
  if (env.GROQ_API_KEY) {
    try {
      // Tronquer à 20 000 caractères pour Groq
      const MAX_CHARS = 20000;
      const truncated = userMessage.length > MAX_CHARS
        ? userMessage.substring(0, MAX_CHARS) + '\n\n[Transcription tronquée]'
        : userMessage;

      const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY?.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens,
          temperature,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: truncated }
          ]
        })
      });

      if (groqResp.status !== 429) {
        const data = await groqResp.json();
        const text = data.choices?.[0]?.message?.content;
        if (groqResp.ok && text) {
          return { text, provider: 'groq' };
        }
      }
    } catch (e) {
      console.error('Groq exception:', e.message);
    }
  }

  // TENTATIVE 3 : Cloudflare Workers AI
  if (env.CLOUDFLARE_AI_TOKEN) {
    try {
      const MAX_CHARS = 10000;
      const truncated = userMessage.length > MAX_CHARS
        ? userMessage.substring(0, MAX_CHARS) + '\n\n[Transcription tronquée]'
        : userMessage;

      const cfResp = await fetch(
        'https://api.cloudflare.com/client/v4/accounts/6d7a982a9e2c57373b33655968afc9b9/ai/run/@cf/meta/llama-3.1-8b-instruct',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.CLOUDFLARE_AI_TOKEN?.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              { role: 'user', content: truncated }
            ],
            max_tokens: maxTokens,
            temperature,
          })
        }
      );
      const data = await cfResp.json();
      if (cfResp.ok && data.result?.response) {
        return { text: data.result.response, provider: 'cloudflare' };
      }
    } catch (e) {
      console.error('Cloudflare AI exception:', e.message);
    }
  }

  throw new Error('Tous les services IA sont indisponibles. Réessaie dans quelques minutes.');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest(context) {
  try {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.headers.get('x-admin-secret') !== env.ADMIN_SECRET) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const systemPrompt = body.system || '';
    const baseUserMessage = body.messages?.[0]?.content
      || body.prompt
      || body.text
      || body.content
      || body.transcript
      || '';

    // Si des segments timestampés sont fournis, les annexer au userMessage
    // pour permettre au modèle de retrouver les moments exacts.
    function formatTime(seconds) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    const segments = Array.isArray(body.segments) ? body.segments : [];
    const segmentsText = segments.length > 0
      ? '\n\nTimestamps disponibles :\n' + segments.slice(0, 200).map(s =>
          `[${formatTime(s.start)} → ${formatTime(s.end)}] ${s.text}`
        ).join('\n')
      : '';
    const userMessage = baseUserMessage + segmentsText;

    const result = await callLLM(env, systemPrompt, userMessage, {
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens:  typeof body.max_tokens  === 'number' ? body.max_tokens  : undefined,
    });

    return new Response(JSON.stringify({
      content: [{ type: 'text', text: result.text }],
      provider: result.provider
    }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
}
