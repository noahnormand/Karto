# Karto

Plateforme de boosters de cartes virtuels pour streamers Twitch. Les viewers échangent leurs points de chaîne contre des boosters, ouvrent des packs en direct et collectionnent des cartes.

**Production → [karto.live](https://karto.live)**

---

## Comment ça marche

### Pour les viewers
1. Ils rachètent une récompense de points de chaîne sur le Twitch du streamer
2. Ils vont sur **karto.live/app**, se connectent avec Twitch
3. Le pack apparaît dans leur inventaire en temps réel (SSE)
4. Ils ouvrent le booster, découvrent leurs cartes, gèrent leur collection

### Pour les streamers
1. Ils remplissent le formulaire de contact sur le site
2. L'admin approuve leur candidature → ils reçoivent accès à **karto.live/admin**
3. Depuis leur dashboard, ils configurent tout eux-mêmes :
   - **Installation** — activent le webhook Twitch en un clic + checklist de mise en ligne
   - **Mes Sets** — configurent les boosters et leurs coûts en points
   - **Mes Cartes** — ajoutent/modifient les cartes avec images
   - **Récompenses** — lient une reward Twitch channel points à leur set

### Pour l'admin
- Se connecte sur `/admin` avec son compte Twitch (ID dans `ADMIN_IDS`)
- Valide les candidatures streamers en un clic
- Gère les EventSubs, streamers, sets globalement

---

## Stack

- **Backend** — Node.js + Express
- **Base de données** — PostgreSQL (Render)
- **Auth** — Twitch OAuth (implicit flow, token navigateur)
- **Temps réel** — Server-Sent Events (SSE)
- **Webhooks** — Twitch EventSub avec vérification HMAC
- **Hébergement** — [Render](https://render.com)

---

## Structure des fichiers

```
karto/
├── server.js          # Serveur Express + toutes les routes API
├── app.html           # App viewer (collection, boosters, boutique)
├── admin.html         # Panel admin + dashboard streamer (Karto Studio)
├── index.html         # Landing page
└── streamers/
    └── {id}/
        ├── config.json          # Config du streamer (nom, couleurs, twitch_id…)
        └── sets/
            └── {setId}/
                ├── config.json  # Config du set (boosters, rarétés, reward_id…)
                └── cards.json   # Liste des cartes
```

> Le filesystem Render est éphémère — toutes les configs sont persistées en PostgreSQL et rechargées au démarrage.

---

## Variables d'environnement

| Variable | Description |
|---|---|
| `TWITCH_CLIENT_ID` | Client ID de l'app Twitch |
| `TWITCH_CLIENT_SECRET` | Client Secret de l'app Twitch |
| `TWITCH_USER_TOKEN` | Token utilisateur (pour PATCH redemptions) |
| `TWITCH_REFRESH_TOKEN` | Refresh token associé |
| `WEBHOOK_SECRET` | Secret HMAC pour les webhooks EventSub |
| `DATABASE_URL` | URL de connexion PostgreSQL |
| `ADMIN_IDS` | IDs Twitch des super admins, séparés par virgule |
| `CALLBACK_URL` | URL du webhook (`https://karto.live/webhook`) |
| `NODE_ENV` | `production` sur Render |

---

## Tables PostgreSQL

| Table | Contenu |
|---|---|
| `karto_config` | Tokens Twitch persistés |
| `viewer_cards` | Collection de cartes par viewer/streamer/set |
| `viewer_packs` | Inventaire de boosters |
| `viewer_essence` | Essence (désenchantement) |
| `streamers_config` | Configs streamers |
| `sets_config` | Configs sets + cartes |
| `streamer_admins` | Lien twitch_id → streamer_id (accès dashboard) |
| `contact_requests` | Candidatures streamers |

---

## API

### Public
| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/streamers` | Liste des streamers et leurs sets |
| `GET` | `/api/streamer/:id/set/:setId/config` | Config d'un set |
| `GET` | `/api/streamer/:id/set/:setId/cards` | Cartes d'un set |
| `GET` | `/api/collection/:viewerId` | Collection d'un viewer |
| `GET` | `/api/packs/:viewerId` | Inventaire boosters |
| `GET` | `/api/essence/:viewerId` | Essence d'un viewer |
| `GET` | `/api/me/role` | Rôle du token Twitch (admin / streamerId) |
| `POST` | `/api/contact` | Soumettre une candidature streamer |

### Admin (token super admin requis)
| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/admin/eventsub` | Liste des webhooks EventSub |
| `POST` | `/api/admin/eventsub` | Créer un webhook |
| `DELETE` | `/api/admin/eventsub/:id` | Supprimer un webhook |
| `GET` | `/api/admin/streamers-full` | Liste complète des streamers |
| `POST` | `/api/admin/streamers` | Créer un streamer |
| `DELETE` | `/api/admin/streamers/:id` | Supprimer un streamer |
| `POST` | `/api/admin/approve/:contactId` | Approuver une candidature |
| `GET` | `/api/admin/contacts` | Liste des candidatures |
| `DELETE` | `/api/admin/contacts/:id` | Supprimer une candidature |

### Dashboard streamer (token streamer requis)
| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/streamer-admin/me` | Ses données (config + sets) |
| `GET` | `/api/streamer-admin/eventsub` | Son webhook EventSub |
| `POST` | `/api/streamer-admin/eventsub` | Activer son webhook |
| `DELETE` | `/api/streamer-admin/eventsub/:id` | Désactiver son webhook |
| `PATCH` | `/api/streamer-admin/set/:setId/config` | Modifier config d'un set |
| `GET` | `/api/streamer-admin/set/:setId/cards` | Ses cartes |
| `POST` | `/api/streamer-admin/set/:setId/cards` | Ajouter une carte |
| `PATCH` | `/api/streamer-admin/set/:setId/card/:cardId` | Modifier une carte |
| `DELETE` | `/api/streamer-admin/set/:setId/card/:cardId` | Supprimer une carte |

---

## Lancer en local

```bash
npm install
# Créer un .env avec les variables ci-dessus
node server.js
```

App disponible sur `http://localhost:3000`

---

## Déployer

Push sur `main` → déploiement automatique sur Render.

```bash
git add -A
git commit -m "..."
git push
```
