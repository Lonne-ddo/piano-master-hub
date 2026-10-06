// ─── Dossiers Analyse (classement global du coach) ───────────────
// Clé MASTERHUB_ANALYSE `analyse_folders` (hors préfixe `analyse:`, donc
// jamais listée comme un morceau) :
//   [{ id, name (1-60 car., unique sans casse), order, createdAt }]
// Chaque analyse:<id> porte un folderId optionnel (absent = « Sans dossier »).

export const FOLDERS_KEY = 'analyse_folders';
export const FOLDER_NAME_MAX = 60;

export async function loadFolders(env) {
  try {
    const raw = await env.MASTERHUB_ANALYSE.get(FOLDERS_KEY, { type: 'json' });
    return Array.isArray(raw) ? raw.filter((f) => f && typeof f.id === 'string') : [];
  } catch {
    return [];
  }
}

export function sortFolders(folders) {
  return folders.slice().sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
}

// Enregistre la liste en renumérotant order 0..n-1 dans l'ordre donné.
export async function saveFolders(env, folders) {
  const next = folders.map((f, i) => ({ ...f, order: i }));
  await env.MASTERHUB_ANALYSE.put(FOLDERS_KEY, JSON.stringify(next));
  return next;
}

// Nom nettoyé, ou { error } si vide / trop long / déjà pris (sans casse).
export function cleanFolderName(raw, folders, exceptId = null) {
  if (typeof raw !== 'string') return { error: 'name_invalid' };
  const name = raw.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > FOLDER_NAME_MAX) {
    return { error: 'name_invalid', detail: `requis 1-${FOLDER_NAME_MAX} caractères` };
  }
  const lower = name.toLocaleLowerCase('fr');
  if (folders.some((f) => f.id !== exceptId && String(f.name).toLocaleLowerCase('fr') === lower)) {
    return { error: 'name_taken' };
  }
  return { name };
}

export function isValidFolderId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}
