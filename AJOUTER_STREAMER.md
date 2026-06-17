# Comment ajouter un streamer sur Karto

> ⚠️ Ce fichier est privé — ne pas pousser sur Git (déjà dans .gitignore).

---

## Étape 1 — Le streamer crée sa récompense sur Twitch

Le streamer va sur son **Tableau de bord Twitch** → **Points de chaîne** → **Gérer les récompenses** → crée une nouvelle récompense avec le nom et le coût qu'il veut (ex: "Booster Karto" à 500 pts).

Il peut créer plusieurs récompenses pour différents types de boosters (ex: 500 pts = Booster, 1200 pts = Pack x3).

---

## Étape 2 — Lancer le script d'ajout

Dans le terminal, depuis le dossier du projet :

```bash
node add_streamer.js <login_twitch_du_streamer>
```

Exemple :
```bash
node add_streamer.js tirazy_
```

Le script :
1. Récupère automatiquement l'ID Twitch du streamer
2. Ouvre une page d'autorisation Twitch dans le navigateur
3. **Le streamer doit se connecter avec son compte Twitch et autoriser l'app**
4. Liste ses récompenses disponibles
5. Tu choisis laquelle correspond au booster → il enregistre le webhook

---

## Étape 3 — Créer le dossier streamer

Créer la structure suivante dans `streamers/` :

```
streamers/
  <id_streamer>/
    config.json
    sets/
      <id_set>/
        config.json
        cards.json
        img/
          c01.png
          c02.png
          ...
```

### config.json (streamer)

```json
{
  "id": "nom_streamer",
  "nom": "Nom Affiché sur le Site",
  "couleur": "#c8a84b",
  "couleur2": "#8b6914",
  "description": "Une phrase de description.",
  "twitch_login": "login_twitch_exact"
}
```

⚠️ `twitch_login` doit être identique au login Twitch (avec underscore si besoin, ex: `tirazy_`).

### config.json (set)

```json
{
  "id": "nom_set",
  "nom": "Nom du Set",
  "description": "Description du set.",
  "date": "2025",
  "couleur": "#1a7fd4",
  "boosters": {
    "single": { "nom": "Booster",  "cout": 500,  "nb_cartes": 10, "garantie": null },
    "pack":   { "nom": "Pack x3",  "cout": 1200, "nb_cartes": 30, "garantie": "Épique" },
    "display":{ "nom": "Display",  "cout": 4000, "nb_cartes": 100,"garantie": "Légendaire" }
  },
  "raretes": {
    "Commun":     { "chance": 50, "couleur": "#8a9bb0" },
    "Peu Commun": { "chance": 30, "couleur": "#4caf80" },
    "Rare":       { "chance": 15, "couleur": "#4a90d9" },
    "Épique":     { "chance": 4,  "couleur": "#9b59b6" },
    "Légendaire": { "chance": 1,  "couleur": "#f0a500" }
  }
}
```

Les clés des boosters (`single`, `pack`, `display`) sont libres — tu peux les nommer comme tu veux et en mettre autant que nécessaire. Le serveur choisit automatiquement le bon booster selon le coût dépensé.

### cards.json

```json
[
  {
    "id": "c01",
    "nom": "Nom de la Carte",
    "type": "Type",
    "rarete": "Rare",
    "image": "c01.png",
    "cout": 3,
    "pv": 60,
    "attaque": 3,
    "defense": 5,
    "capacites": [
      { "nom": "Nom capacité", "texte": "Description de l'effet." }
    ],
    "citation": "« Une citation. »"
  }
]
```

---

## Étape 4 — Ajouter les images

Placer les images dans `streamers/<id>/sets/<set_id>/img/` sous forme de fichiers PNG nommés `c01.png`, `c02.png`, etc.

---

## Étape 5 — Pousser sur GitHub

```bash
git add -A
git commit -m "add streamer <nom>"
git push
```

Render redéploie automatiquement.

---

## En cas d'expiration du token Twitch

Si les récompenses ne se marquent plus comme terminées automatiquement, relancer :

```bash
node get_user_token.js
```

Puis mettre à jour `TWITCH_USER_TOKEN` et `TWITCH_REFRESH_TOKEN` dans les variables d'environnement Render.

