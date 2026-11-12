// ─── Liste des élèves : source unique = KV `eleves:list` ──────────
// Aucune liste en dur : si le KV est indisponible (binding absent,
// erreur de lecture, clé manquante ou illisible), on le dit (null)
// et l'appelant renvoie une erreur propre (503) plutôt que de deviner.

// Retourne le tableau des slugs (minuscules) ou null si indisponible.
export async function readElevesList(env) {
  if (!env || !env.MASTERHUB_STUDENTS) return null;
  try {
    const list = await env.MASTERHUB_STUDENTS.get('eleves:list', { type: 'json' });
    if (!Array.isArray(list)) return null;
    return list.map(s => String(s).toLowerCase());
  } catch {
    return null;
  }
}

// true = élève connu, false = inconnu, null = liste indisponible.
export async function checkSlug(env, slug) {
  if (!slug) return false;
  const list = await readElevesList(env);
  if (list === null) return null;
  return list.includes(String(slug).toLowerCase());
}

export const ELEVES_UNAVAILABLE = { error: 'eleves_list_unavailable' };
