// ─── CORS helpers partagés (D4) ──────────────────────────────────
// Les endpoints admin restreignent Origin au domaine canonique +
// previews CF Pages (*.piano-master-hub.pages.dev).
// Les endpoints publics gardent Origin '*' (pas de restriction).

const ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)?piano-master-hub\.pages\.dev$/;
const CANONICAL = 'https://piano-master-hub.pages.dev';

// Réfléchit l'Origin si match domaine canonique ou preview CF, sinon canonical.
// `Vary: Origin` indispensable pour que CDN ne cache pas la mauvaise variante.
export function corsAdmin(request, opts) {
  opts = opts || {};
  const origin = (request && request.headers && request.headers.get('Origin')) || '';
  const allowed = ORIGIN_PATTERN.test(origin) ? origin : CANONICAL;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': opts.methods || 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': opts.headers || 'Content-Type, x-admin-secret, Authorization',
    'Vary': 'Origin',
  };
}

// Endpoints publics (slug whitelist + score validation) → Origin '*' OK.
export const CORS_PUBLIC = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
