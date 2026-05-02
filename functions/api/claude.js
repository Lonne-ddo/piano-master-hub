// Pipeline LLM : Claude Sonnet 4.6 → Gemini 2.5 Flash → Groq Llama 3.3
// Les 3 providers reçoivent le MÊME system prompt (cohérence des résultats).
//
// Auth : admin via cookie mh_admin_pw (HMAC).

import { requireAdminPassword } from './_lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Helpers ──────────────────────────────────────────────────────
function isRetryableError(error) {
  const msg = String(error?.message || '');
  return /\b(429|500|502|503|504|UNAVAILABLE|overloaded|timeout|network|fetch failed)\b/i.test(msg);
}

// Normalise la sortie LLM : retire les fences markdown si présentes.
// Le client fait ensuite son propre JSON.parse() avec fallback robuste.
function extractJSON(text) {
  if (!text) return '';
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  return s;
}

// ── Providers ────────────────────────────────────────────────────
async function callClaude(env, systemPrompt, userMessage, opts = {}) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: opts.max_tokens || 8000,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Claude: réponse vide');
  return text;
}

async function callGemini(env, systemPrompt, userMessage, opts = {}) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante');

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage,
          }],
        }],
        generationConfig: {
          maxOutputTokens: opts.max_tokens || 8000,
          temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
        },
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: réponse vide');
  return text;
}

async function callGroq(env, systemPrompt, userMessage, opts = {}) {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY manquante');

  // Groq context window plus petit → tronquer si nécessaire
  const MAX_CHARS = 20000;
  const truncated = userMessage.length > MAX_CHARS
    ? userMessage.substring(0, MAX_CHARS) + '\n\n[Transcription tronquée — limite Groq]'
    : userMessage;

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: Math.min(opts.max_tokens || 8000, 8000),
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: truncated },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Groq HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq: réponse vide');
  return text;
}

// ── Orchestrateur : Claude → Gemini → Groq ──────────────────────
async function callLLM(env, systemPrompt, userMessage, opts = {}) {
  let lastError = null;

  // TENTATIVE 1 : Claude Sonnet 4.6 (moteur principal)
  if (env.ANTHROPIC_API_KEY) {
    try {
      console.log('[claude.js] tentative claude-sonnet-4-6 (1)');
      const text = await callClaude(env, systemPrompt, userMessage, opts);
      return { text: extractJSON(text), provider: 'claude-sonnet-4-6' };
    } catch (e) {
      console.log('[claude.js] Claude failed:', e.message);
      lastError = e;
      if (!isRetryableError(e)) throw e;
    }
  }

  // TENTATIVE 2 : Gemini 2.5 Flash (fallback 1)
  if (env.GEMINI_API_KEY) {
    try {
      console.log('[claude.js] tentative gemini-2.5-flash (2)');
      const text = await callGemini(env, systemPrompt, userMessage, opts);
      return { text: extractJSON(text), provider: 'gemini-2.5-flash' };
    } catch (e) {
      console.log('[claude.js] Gemini failed:', e.message);
      lastError = e;
      if (!isRetryableError(e)) throw e;
    }
  }

  // TENTATIVE 3 : Groq Llama 3.3 (fallback 2 — dernier recours)
  if (env.GROQ_API_KEY) {
    try {
      console.log('[claude.js] tentative llama-3.3-70b-versatile (3)');
      const text = await callGroq(env, systemPrompt, userMessage, opts);
      return { text: extractJSON(text), provider: 'groq-llama-3.3' };
    } catch (e) {
      console.log('[claude.js] Groq failed:', e.message);
      lastError = e;
    }
  }

  throw lastError || new Error('Aucun provider LLM configuré');
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

    if (!(await requireAdminPassword(request, env))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const systemPrompt = body.system || '';
    const baseUserMessage = body.messages?.[0]?.content
      || body.prompt
      || body.text
      || body.content
      || body.transcript
      || '';

    if (typeof baseUserMessage !== 'string' || !baseUserMessage.trim()) {
      return new Response(JSON.stringify({ error: 'empty_message' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Annexer les segments timestampés au userMessage si fournis (utile pour
    // retrouver des moments exacts du cours)
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

    let result;
    try {
      result = await callLLM(env, systemPrompt, userMessage, {
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        max_tokens:  typeof body.max_tokens  === 'number' ? body.max_tokens  : undefined,
      });
    } catch (err) {
      console.error('[claude.js] All providers failed:', err.message);
      return new Response(JSON.stringify({
        error: 'Tous les providers LLM sont indisponibles',
        details: err.message,
      }), {
        status: 503,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      content: [{ type: 'text', text: result.text }],
      provider: result.provider,
    }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
