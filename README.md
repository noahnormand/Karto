# Karto

Karto permet aux viewers Twitch d'ouvrir des boosters virtuels de cartes à collectionner en échangeant leurs points de chaîne.

Chaque streamer partenaire a son propre univers - ses cartes, ses personnages, ses raretés. Un viewer accumule des points sur Twitch, rachète une récompense, et reçoit un booster à ouvrir sur le site quand il veut.

**karto-182e.onrender.com**

---

## Comment ça marche

1. Le viewer rachète une récompense de points de chaîne sur Twitch
2. Karto reçoit la notification en temps réel via Twitch EventSub
3. Un booster apparaît dans l'inventaire du viewer
4. Le viewer ouvre son booster sur le site - les cartes sont révélées une par une
5. Les cartes s'ajoutent à sa collection, consultable à tout moment

---

## Fonctionnalités

- Ouverture de boosters animée avec révélation carte par carte
- Collection personnelle avec filtres par rareté
- Vue par streamer et par série
- Cartes non possédées affichées en silhouette
- Progression du set (x/total cartes)
- Notifications temps réel - le booster arrive sans refresh de page
- Support multi-streamers et multi-sets

---

## Stack

- Node.js + Express
- PostgreSQL - Neon
- Twitch EventSub webhooks
- HTML/CSS/JS vanilla
- Render

---

## Ajouter un streamer

```bash
node add_streamer.js <twitch_login>
```

Le script ouvre une page d'autorisation Twitch, récupère les récompenses du streamer, et enregistre le webhook automatiquement.

Créer ensuite le dossier `streamers/<id>/` avec :
- `config.json` - nom, couleurs, login Twitch
- `sets/<set_id>/config.json` - boosters, raretés
- `sets/<set_id>/cards.json` - liste des cartes
- `sets/<set_id>/img/` - images des cartes
