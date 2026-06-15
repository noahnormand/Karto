# Karto 🃏

Application web permettant aux viewers Twitch d'ouvrir des boosters virtuels de cartes à collectionner en échangeant leurs points de chaîne.

## Fonctionnement

1. Un viewer rachète une récompense de points de chaîne sur Twitch
2. Twitch envoie un webhook à l'application
3. L'application tire des cartes aléatoirement selon les taux de rareté du set
4. Les cartes sont sauvegardées dans la collection du viewer
5. Le viewer peut ouvrir son booster sur le site et consulter sa collection

## Demo

→ [karto-182e.onrender.com](https://karto-182e.onrender.com)

Streamer de démo : **Karto Demo** — set *L'Ère de la Vapeur* (10 cartes steampunk)

## Stack

- **Frontend** : HTML/CSS/JS vanilla
- **Backend** : Node.js + Express
- **Base de données** : PostgreSQL (Neon)
- **Hébergement** : Render
- **Intégration** : Twitch EventSub (webhooks)

## Structure des fichiers

```
streamers/
  {streamer_id}/
    config.json          # Infos du streamer (nom, couleurs, twitch_login)
    sets/
      {set_id}/
        config.json      # Infos du set (boosters, taux de rareté)
        cards.json       # Liste des cartes
        img/             # Images des cartes (c01.png, c02.png, ...)
server.js                # Serveur Express
register_eventsub.js     # Script d'enregistrement webhook Twitch (one-shot)
index.html               # Interface utilisateur
```

## Variables d'environnement

Créer un fichier `.env` à la racine :

```env
DATABASE_URL=           # PostgreSQL connection string
WEBHOOK_SECRET=         # Secret HMAC pour vérifier les webhooks Twitch
TWITCH_CLIENT_ID=       # Client ID de l'app Twitch (type Confidential)
TWITCH_CLIENT_SECRET=   # Client Secret de l'app Twitch
TWITCH_BROADCASTER_ID=  # ID Twitch du streamer
```

## Installation

```bash
npm install
node server.js
```

## Enregistrer le webhook Twitch

Une fois l'app déployée et les variables d'environnement configurées :

```bash
node register_eventsub.js
```

Ce script enregistre la souscription EventSub `channel.channel_points_custom_reward_redemption.add` pointant vers `/webhook`.

## Ajouter un streamer

1. Créer `streamers/{id}/config.json`
2. Créer `streamers/{id}/sets/{set_id}/config.json` avec les boosters et rarités
3. Créer `streamers/{id}/sets/{set_id}/cards.json` avec les cartes
4. Placer les images dans `streamers/{id}/sets/{set_id}/img/`

### Format config.json (streamer)

```json
{
  "id": "mon_streamer",
  "nom": "Nom Affiché",
  "couleur": "#c8a84b",
  "couleur2": "#8b6914",
  "description": "Description du set.",
  "twitch_login": "login_twitch"
}
```

### Format cards.json

```json
[
  {
    "id": "c01",
    "nom": "Nom de la carte",
    "type": "Type",
    "rarete": "Rare",
    "image": "c01.png",
    "cout": 3,
    "pv": 60,
    "attaque": 3,
    "defense": 5,
    "capacites": [
      { "nom": "Nom capacité", "texte": "Effet de la capacité." }
    ],
    "citation": "« Citation de la carte. »"
  }
]
```

Rarités disponibles : `Commun`, `Peu Commun`, `Rare`, `Épique`, `Légendaire`
