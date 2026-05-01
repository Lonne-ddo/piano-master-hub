// ─── POST /api/auth/request-link ─────────────────────────────────
// Body : { email: string }
// Recherche l'élève par email dans le KV. Si trouvé, génère un magic link
// (token 32 bytes random, TTL 15 min, single-use) et envoie l'email via Resend.
//
// Anti-énumération : retourne TOUJOURS { ok: true } si l'email a un format
// valide, qu'il existe ou non en KV. Aucun moyen pour un attaquant de savoir
// quels emails sont enregistrés.

import { generateToken, isAdminEmail } from '../_lib/session.js';

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
  if (!env.MASTERHUB_STUDENTS) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }
  if (!env.RESEND_API_KEY) {
    return jsonResponse({ error: 'email_not_configured' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'invalid_email' }, 400);
  }

  // ── Branche super-admin (ADMIN_EMAILS env var) ─────────────────
  const adminMatch = isAdminEmail(email, env);

  // Si pas admin, recherche l'élève par email dans le KV
  let foundSlug = null;
  if (!adminMatch) {
    let slugs;
    try {
      const listRaw = await env.MASTERHUB_STUDENTS.get('eleves:list');
      slugs = listRaw ? JSON.parse(listRaw) : ['japhet', 'messon', 'dexter', 'tara'];
    } catch {
      slugs = ['japhet', 'messon', 'dexter', 'tara'];
    }
    for (const slug of slugs) {
      let raw;
      try { raw = await env.MASTERHUB_STUDENTS.get(`eleve:${slug}`); }
      catch { continue; }
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        if (data.email && String(data.email).toLowerCase() === email) {
          foundSlug = slug;
          break;
        }
      } catch { /* skip */ }
    }

    // Anti-énumération : si email inconnu, on retourne ok=true sans envoyer.
    if (!foundSlug) {
      console.log('[auth/request-link] unknown_email_silent_ok');
      return jsonResponse({ ok: true, message: 'email_sent_if_valid' });
    }
  }

  // Génère + stocke le magic link (TTL 15 min, single-use via delete au verify)
  const token = generateToken(32);
  const magicLink = adminMatch
    ? { is_admin: true, email, createdAt: Date.now() }
    : { slug: foundSlug, email, createdAt: Date.now() };
  try {
    await env.MASTERHUB_STUDENTS.put(
      `magic_link:${token}`,
      JSON.stringify(magicLink),
      { expirationTtl: 900 }
    );
  } catch (e) {
    console.error('[auth/request-link] KV put failed:', e?.message || e);
    return jsonResponse({ error: 'kv_put_failed' }, 500);
  }

  // Construit l'URL de verify (même origine que la requête)
  const reqUrl = new URL(request.url);
  const verifyUrl = `${reqUrl.protocol}//${reqUrl.host}/api/auth/verify?token=${token}`;

  // Envoi via Resend
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Master Hub <onboarding@resend.dev>',
        to: [email],
        subject: adminMatch ? 'Connexion super-admin Master Hub' : 'Connexion à Master Hub',
        html: buildEmailHtml(verifyUrl, foundSlug, adminMatch),
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text().catch(() => '');
      console.error('[auth/request-link] Resend HTTP', emailRes.status, errText.slice(0, 300));
      // On a déjà mis le magic_link en KV — il expirera tout seul. Pas de cleanup.
      return jsonResponse({ error: 'email_send_failed' }, 502);
    }
  } catch (e) {
    console.error('[auth/request-link] Resend network error:', e?.message || e);
    return jsonResponse({ error: 'email_send_failed' }, 502);
  }

  return jsonResponse({ ok: true, message: 'email_sent' });
}

function buildEmailHtml(verifyUrl, slug, isAdmin) {
  const display = isAdmin
    ? 'super-admin'
    : (slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '');
  const safeUrl = String(verifyUrl).replace(/"/g, '%22');
  const intro = isAdmin
    ? 'Voici ton lien de connexion super-admin à Master Hub. Il expire dans 15 minutes.'
    : `Bonjour ${display},<br><br>Voici ton lien de connexion à Master Hub. Il expire dans 15 minutes.`;
  return `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; padding: 40px 20px; margin: 0;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 40px 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
    <h1 style="color: #1a1a24; font-size: 22px; margin: 0 0 8px; font-weight: 700;">Master Hub${isAdmin ? ' — Super-admin' : ''}</h1>
    <p style="color: #555; font-size: 15px; line-height: 1.55; margin: 16px 0;">
      ${intro}
    </p>
    <a href="${safeUrl}" style="display: inline-block; margin-top: 16px; background: #8B6FE8; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Se connecter</a>
    <p style="color: #888; font-size: 12px; margin-top: 32px; line-height: 1.5;">
      Si tu n'es pas à l'origine de cette demande, ignore simplement cet email — aucune action ne sera prise.
    </p>
  </div>
</body>
</html>`;
}
