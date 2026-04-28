// ─── POST /api/quiz/submit ───────────────────────────────────────
// Endpoint PUBLIC (pas d'auth) — la whitelist slug fait office de garde-fou.
// Stocke chaque session dans KV MASTERHUB_QUIZ_HISTORY sous la clé
// `quiz:<slug>:<timestamp>`.
//
// Body attendu :
// {
//   slug: "japhet" | "tara" | "dexter" | "messon",
//   mode: "notes" | "intervals" | "chords",
//   level: "debutant" | "intermediaire" | "avance",
//   score: 0..10,
//   total: 10,
//   duration_ms: int > 0,
//   questions: [{ asked, asked_name, given, correct: bool }, …] (10 entrées)
// }

const VALID_SLUGS = ['japhet', 'tara', 'dexter', 'messon'];
const VALID_MODES = ['notes', 'intervals', 'chords', 'scales', 'progressions'];
const VALID_LEVELS = ['debutant', 'intermediaire', 'avance'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let data;
  try { data = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  // Validation stricte
  const slug = String(data.slug || '').toLowerCase();
  if (!VALID_SLUGS.includes(slug)) {
    return json({ ok: false, error: 'invalid_slug' }, 400);
  }
  if (!VALID_MODES.includes(data.mode)) {
    return json({ ok: false, error: 'invalid_mode' }, 400);
  }
  if (!VALID_LEVELS.includes(data.level)) {
    return json({ ok: false, error: 'invalid_level' }, 400);
  }
  const score = Number(data.score);
  const total = Number(data.total);
  if (!Number.isInteger(score) || score < 0 || score > 20) {
    return json({ ok: false, error: 'invalid_score' }, 400);
  }
  if (!Number.isInteger(total) || total < 1 || total > 50) {
    return json({ ok: false, error: 'invalid_total' }, 400);
  }
  const duration = Number(data.duration_ms);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 30 * 60 * 1000) {
    return json({ ok: false, error: 'invalid_duration_ms' }, 400);
  }
  if (!Array.isArray(data.questions) || data.questions.length !== total) {
    return json({ ok: false, error: 'invalid_questions' }, 400);
  }
  // Sanitize chaque question (whitelist 4 champs)
  const sanitizedQuestions = data.questions.map(q => ({
    asked: String(q.asked || ''),
    asked_name: q.asked_name ? String(q.asked_name) : null,
    given: q.given ? String(q.given) : null,
    correct: !!q.correct,
  }));

  if (!env.MASTERHUB_QUIZ_HISTORY) {
    return json({
      ok: false,
      error: 'kv_not_bound',
      hint: 'Ajouter MASTERHUB_QUIZ_HISTORY dans CF Pages → Settings → Functions → KV namespace bindings',
    }, 500);
  }

  const ts = Date.now();
  const key = `quiz:${slug}:${ts}`;
  const value = JSON.stringify({
    slug,
    mode: data.mode,
    level: data.level,
    score,
    total,
    duration_ms: duration,
    questions: sanitizedQuestions,
    ts,
    ts_iso: new Date(ts).toISOString(),
  });

  try {
    await env.MASTERHUB_QUIZ_HISTORY.put(key, value);
  } catch (e) {
    return json({ ok: false, error: 'kv_put_failed', details: e?.message || '' }, 500);
  }

  return json({ ok: true, key });
}
