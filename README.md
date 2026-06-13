# Karto

Ouvre des boosters de cartes virtuelles avec tes points de chaîne Twitch.

Chaque streamer configure ses propres sets et cartes. Quand un viewer dépense ses points, il reçoit un pack dans son inventaire — il peut l'ouvrir quand il veut sur le site.

**Live** → [karto-182e.onrender.com](https://karto-182e.onrender.com)

---

## Stack

- Node.js + Express
- PostgreSQL (Neon)
- Twitch OAuth (Implicit Grant) + EventSub webhooks
- Tailwind CDN

---

## Déploiement

Hébergé sur [Render](https://render.com) (free tier) avec une base PostgreSQL [Neon](https://neon.tech) (free tier).

Variables d'environnement requises :
```
DATABASE_URL=postgresql://...
NODE_ENV=production
```

---

## Lancer en local

```bash
npm install
node server.js
```

Crée un fichier `.env` à la racine avec ta `DATABASE_URL` Neon.

Le serveur local tourne sur `https://localhost:3000` (HTTPS requis pour l'OAuth Twitch).  
Génère les certificats auto-signés si besoin :

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

---

## Ajouter un streamer

```
streamers/
  mon-streamer/
    config.json
    sets/
      saison1/
        config.json
        cards.json
        img/
```

**`config.json` streamer**
```json
{
  "id": "mon-streamer",
  "nom": "Mon Streamer",
  "couleur": "#ff6b00",
  "twitch_login": "login_twitch"
}
```

**`config.json` set**
```json
{
  "id": "saison1",
  "nom": "Saison 1",
  "couleur": "#ff6b00",
  "boosters": {
    "single": { "nom": "Booster", "cout": 500,  "nb_cartes": 10, "garantie": null },
    "pack":   { "nom": "Pack x3", "cout": 1200, "nb_cartes": 30, "garantie": "Épique" }
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

**`cards.json`**
```json
[
  {
    "id": "c01",
    "nom": "Nom de la carte",
    "type": "Joueur",
    "rarete": "Rare",
    "emoji": "⚡",
    "image": "c01.png",
    "desc": "Description courte."
  }
]
```

Le champ `image` accepte un nom de fichier (dans `img/`), une URL externe, ou peut être omis (fallback sur l'emoji).

---

## Webhook Twitch

Pointe ton EventSub `channel.channel_points_custom_reward_redemption.add` vers `/webhook`.  
En dev, utilise [ngrok](https://ngrok.com) ou la [Twitch CLI](https://github.com/twitchdev/twitch-cli) pour exposer le serveur local.

---

## Ce qui n'est pas dans le repo

```
node_modules/
karto.db
key.pem
cert.pem
.env
```
