# Ajouter un nouvel élève — procédure manuelle

Tant que le **Chantier B (sync Bonzai automatique)** n'est pas livré, ajouter un nouvel élève
demande 3 étapes manuelles. Le KV `eleves:list` est la source de vérité ; le hardcoded
n'est plus que fallback de dégradation gracieuse.

## 1. Ajouter le slug dans `eleves:list`

Depuis le dashboard Cloudflare Pages → Workers KV → namespace `MASTERHUB_STUDENTS` →
clé `eleves:list`, éditer le tableau JSON :

```json
["japhet","messon","dexter","tara","nouveau"]
```

OU via wrangler CLI :

```bash
wrangler kv:key get --binding=MASTERHUB_STUDENTS "eleves:list"
# édite localement, puis :
wrangler kv:key put --binding=MASTERHUB_STUDENTS "eleves:list" '["japhet","messon","dexter","tara","nouveau"]'
```

## 2. Créer la fiche élève initiale dans le KV

Depuis la console DevTools sur `/admin/` (auth déjà active) :

```js
fetch('/api/eleves/nouveau', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'x-admin-secret': '4697' },
  body: JSON.stringify({})
}).then(r => r.json()).then(console.log)
```

Le PATCH retournera 404 tant que la clé `eleve:nouveau` n'existe pas. Pour bootstrap minimal,
utiliser plutôt directement le KV dashboard avec :

```json
{
  "id": "nouveau",
  "nom": "Nouveau",
  "programme": "Piano Master",
  "statut": "actif",
  "doc_id": "GOOGLE_DOC_ID_ICI",
  "doc_url": "https://docs.google.com/document/d/GOOGLE_DOC_ID_ICI/edit"
}
```

clé : `eleve:nouveau`

## 3. Ajouter la route `_redirects`

Éditer `/_redirects` et ajouter :

```
/nouveau/devoirs   /nouveau    301
/nouveau           /index.html 200
```

Commit + push (CF Pages redéploie automatiquement le routing).

## 4. Premier sync

Depuis `/admin/`, cliquer **🔄 Sync All**. Le nouveau slug est fetché depuis son Google Doc,
parsé par le LLM et complété (théorie, répertoire, canaux, dernière séance).

## Future : Chantier B

Cette procédure sera automatisée par un webhook Bonzai qui écoutera les achats et créera
automatiquement (1) la fiche KV, (2) le Google Doc, (3) la session admin pour l'élève.
Le `_redirects` restera la seule étape manuelle (fichier statique CF Pages).
