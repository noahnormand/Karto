# Karto

Karto permet aux viewers Twitch d'ouvrir des boosters virtuels de cartes à collectionner en échangeant leurs points de chaîne.

Chaque streamer partenaire dispose de son propre set de cartes. Quand un viewer rachète la récompense sur Twitch, il reçoit un booster dans son inventaire  -  il peut l'ouvrir quand il veut sur le site, découvrir ses cartes et consulter sa collection.

**→ [karto-182e.onrender.com](https://karto-182e.onrender.com)**

---

## C'est quoi exactement ?

Un viewer regarde un stream, accumule des points de chaîne Twitch, et peut les dépenser pour ouvrir un booster de cartes propres au streamer. Les cartes ont des raretés (Commun, Peu Commun, Rare, Épique, Légendaire), des stats et des capacités. Le viewer retrouve toutes ses cartes dans sa collection sur le site.

Chaque streamer a son univers : ses propres cartes, son propre set, ses propres personnages.

---

## Streamers partenaires

Pour l'instant le projet est en phase de développement avec un set de démonstration  -  univers steampunk, 10 cartes à collectionner.

Si tu es streamer et que tu veux rejoindre Karto avec ton propre set, contacte-nous.

---

## Stack technique

- Node.js + Express (backend)
- PostgreSQL via Neon (base de données)
- Twitch EventSub (webhooks points de chaîne)
- HTML/CSS/JS vanilla (frontend)
- Hébergé sur Render
