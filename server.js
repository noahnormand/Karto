require('dotenv').config()

const express    = require('express')
const https      = require('https')
const http       = require('http')
const fs         = require('fs')
const path       = require('path')
const crypto     = require('crypto')
const { Pool }   = require('pg')
const multer     = require('multer')
const cloudinary = require('cloudinary').v2
const rateLimit  = require('express-rate-limit')

const app            = express()
const prod           = process.env.NODE_ENV === 'production'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID     || ''
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || ''
let   twitchUserToken      = process.env.TWITCH_USER_TOKEN    || ''
let   twitchRefreshToken   = process.env.TWITCH_REFRESH_TOKEN || ''
const ADMIN_IDS            = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean))
const CALLBACK_URL         = process.env.CALLBACK_URL || 'https://karto.live/webhook'

// ── Cloudinary ───────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// ── Input sanitization ───────────────────────────────────────────────────────
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return ''
  return str.trim().slice(0, maxLen)
}
function isValidId(id) { return /^[a-zA-Z0-9_-]{1,50}$/.test(id) }
function isValidColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) }

// ── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Trop de requêtes, réessaie plus tard' } })
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Trop de requêtes, réessaie plus tard' } })
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Trop d\'uploads, réessaie plus tard' } })

async function refreshTwitchToken() {
  if (!twitchRefreshToken) return false
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: twitchRefreshToken,
        client_id:     TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET
      })
    })
    const data = await res.json()
    if (!data.access_token) { console.log('Refresh token invalide:', data); return false }
    twitchUserToken    = data.access_token
    twitchRefreshToken = data.refresh_token || twitchRefreshToken
    console.log('Token Twitch renouvelé automatiquement.')
    await saveTokensToDB()
    return true
  } catch(e) {
    console.log('Erreur refresh token:', e.message)
    return false
  }
}

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf }
}))
app.use(express.static('public'))
app.use('/streamers', express.static('streamers'))

// streamers en mémoire : { test: { config, sets: { saison1: { config, cards } } } }
const streamers      = {}
const twitchToStreamer = {} // login twitch -> id dossier

function loadStreamers() {
  const dir = 'streamers'
  if (!fs.existsSync(dir)) return

  for (const id of fs.readdirSync(dir)) {
    const configPath = path.join(dir, id, 'config.json')
    if (!fs.existsSync(configPath)) continue

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    streamers[id] = { config, sets: {} }

    if (config.twitch_login) {
      twitchToStreamer[config.twitch_login.toLowerCase()] = id
    }

    const setsDir = path.join(dir, id, 'sets')
    if (!fs.existsSync(setsDir)) continue

    for (const setId of fs.readdirSync(setsDir)) {
      const setConfig = path.join(setsDir, setId, 'config.json')
      const setCards  = path.join(setsDir, setId, 'cards.json')
      if (!fs.existsSync(setConfig)) continue

      streamers[id].sets[setId] = {
        config: JSON.parse(fs.readFileSync(setConfig, 'utf-8')),
        cards:  fs.existsSync(setCards) ? JSON.parse(fs.readFileSync(setCards, 'utf-8')) : []
      }
      console.log(`  ${id}/${setId} — ${streamers[id].sets[setId].cards.length} cartes`)
    }

    console.log(`streamer: ${id} (${config.nom})`)
  }
}

loadStreamers()

async function loadStreamersFromDB() {
  try {
    const { rows: sRows } = await db.query('SELECT id, config FROM streamers_config')
    for (const row of sRows) {
      const id = row.id
      const config = row.config
      if (!streamers[id]) streamers[id] = { config, sets: {} }
      else streamers[id].config = config
      if (config.twitch_login) twitchToStreamer[config.twitch_login.toLowerCase()] = id
    }
    const { rows: setRows } = await db.query('SELECT streamer_id, set_id, config, cards FROM sets_config')
    for (const row of setRows) {
      const { streamer_id, set_id, config, cards } = row
      if (!streamers[streamer_id]) continue
      streamers[streamer_id].sets[set_id] = { config, cards: cards || [] }
    }
    if (sRows.length) console.log(`${sRows.length} streamers chargés depuis DB`)
  } catch(e) {
    console.log('loadStreamersFromDB:', e.message)
  }
}


// base de données

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: prod ? { rejectUnauthorized: false } : false
})

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS karto_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS viewer_cards (
      viewer_id   TEXT NOT NULL,
      streamer_id TEXT NOT NULL,
      set_id      TEXT NOT NULL DEFAULT '',
      carte_id    TEXT NOT NULL,
      quantite    INTEGER DEFAULT 1,
      PRIMARY KEY (viewer_id, streamer_id, set_id, carte_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS viewer_packs (
      viewer_id    TEXT NOT NULL,
      streamer_id  TEXT NOT NULL,
      set_id       TEXT NOT NULL,
      booster_type TEXT NOT NULL,
      quantite     INTEGER DEFAULT 0,
      PRIMARY KEY (viewer_id, streamer_id, set_id, booster_type)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS viewer_essence (
      viewer_id   TEXT NOT NULL,
      streamer_id TEXT NOT NULL,
      set_id      TEXT NOT NULL,
      quantite    INTEGER DEFAULT 0,
      PRIMARY KEY (viewer_id, streamer_id, set_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS streamers_config (
      id         TEXT PRIMARY KEY,
      config     JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sets_config (
      streamer_id TEXT NOT NULL,
      set_id      TEXT NOT NULL,
      config      JSONB NOT NULL,
      cards       JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (streamer_id, set_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS streamer_admins (
      streamer_id TEXT NOT NULL,
      twitch_id   TEXT PRIMARY KEY
    )
  `)
  console.log('db ok')
}

async function loadTokensFromDB() {
  try {
    const { rows } = await db.query(
      "SELECT key, value FROM karto_config WHERE key IN ('TWITCH_USER_TOKEN', 'TWITCH_REFRESH_TOKEN')"
    )
    for (const row of rows) {
      if (row.key === 'TWITCH_USER_TOKEN')    twitchUserToken    = row.value
      if (row.key === 'TWITCH_REFRESH_TOKEN') twitchRefreshToken = row.value
    }
    if (rows.length) console.log('Tokens Twitch chargés depuis la DB.')
  } catch(e) {
    console.log('Impossible de charger les tokens depuis la DB:', e.message)
  }
}

async function saveTokensToDB() {
  try {
    await db.query(`
      INSERT INTO karto_config (key, value)
      VALUES ('TWITCH_USER_TOKEN', $1), ('TWITCH_REFRESH_TOKEN', $2)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `, [twitchUserToken, twitchRefreshToken])
  } catch(e) {
    console.log('Erreur sauvegarde tokens DB:', e.message)
  }
}

// Clés autorisées pour PATCH config d'un set (anti escalation)
const ALLOWED_SET_CONFIG_KEYS = ['nom', 'description', 'date', 'couleur', 'reward_id', 'boosters', 'raretes']
function pickSetConfig(body) {
  const out = {}
  for (const k of ALLOWED_SET_CONFIG_KEYS) if (k in (body || {})) out[k] = body[k]
  return out
}

// defaults essence si non définis dans config
const DEFAULT_ESSENCE_RARETE = {
  'Commun': 5, 'Peu Commun': 10, 'Rare': 25, 'Épique': 75, 'Légendaire': 200
}
const DEFAULT_COUT_ESSENCE = { single: 100, pack: 250, display: 800 }


// contact streamer

const contactRateLimit = new Map() // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = contactRateLimit.get(ip)
  if (!entry || now > entry.resetAt) {
    contactRateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 })
    return true
  }
  if (entry.count >= 3) return false
  entry.count++
  return true
}

// Lookup Twitch public (rate-limité par IP : 30/min) — utilisé par le form de candidature
const lookupRateLimit = new Map()
function checkLookupRate(ip) {
  const now = Date.now()
  const entry = lookupRateLimit.get(ip)
  if (!entry || now > entry.resetAt) {
    lookupRateLimit.set(ip, { count: 1, resetAt: now + 60 * 1000 })
    return true
  }
  if (entry.count >= 30) return false
  entry.count++
  return true
}

let cachedAppToken = { token: null, expiresAt: 0 }
async function getAppToken() {
  if (cachedAppToken.token && Date.now() < cachedAppToken.expiresAt) return cachedAppToken.token
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET })
  })
  const data = await r.json()
  cachedAppToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 }
  return data.access_token
}

app.get('/api/twitch/user/:login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || ''
  if (!checkLookupRate(ip)) return res.status(429).json({ error: 'Trop de requêtes' })

  const login = (req.params.login || '').toLowerCase().trim()
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return res.status(400).json({ error: 'Login invalide' })

  try {
    const tok = await getAppToken()
    const r = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    const data = await r.json()
    const user = data.data?.[0]
    if (!user) return res.status(404).json({ error: 'Streamer introuvable' })
    res.json({
      id: user.id,
      login: user.login,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url,
      broadcaster_type: user.broadcaster_type // '', 'affiliate', 'partner'
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Notif Discord (no-op si DISCORD_WEBHOOK_URL non configuré)
async function notifyDiscord(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch(e) { console.log('Discord webhook erreur:', e.message) }
}

app.post('/api/contact', authLimiter, async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || ''

  // Rate limiting : 3 soumissions max par heure par IP
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans une heure.' })
  }

  const { twitch, email, message, tcg_url, website } = req.body

  // Honeypot : si rempli c'est un bot
  if (website) return res.status(400).json({ error: 'invalid' })

  // Validation
  if (!twitch || !email) return res.status(400).json({ error: 'Champs requis manquants.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' })
  if (twitch.length > 50 || email.length > 100) return res.status(400).json({ error: 'Champ trop long.' })

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS contact_requests (
        id         SERIAL PRIMARY KEY,
        twitch     TEXT NOT NULL,
        email      TEXT NOT NULL,
        tcg_url    TEXT,
        message    TEXT,
        ip         TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    // migration : ajoute les colonnes enrichies si absentes
    await db.query(`ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS twitch_id TEXT`)
    await db.query(`ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS display_name TEXT`)
    await db.query(`ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS avatar_url TEXT`)
    await db.query(`ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS broadcaster_type TEXT`)

    // Re-valide le login côté serveur pour éviter qu'un client malicieux envoie des données bidon
    let verifiedUser = null
    try {
      const tok = await getAppToken()
      const r = await fetch(`https://api.twitch.tv/helix/users?login=${twitch.trim().toLowerCase()}`, {
        headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
      })
      verifiedUser = (await r.json()).data?.[0] || null
    } catch(_) {}
    if (!verifiedUser) return res.status(400).json({ error: 'Login Twitch introuvable.' })

    await db.query(
      'INSERT INTO contact_requests (twitch, email, tcg_url, message, ip, twitch_id, display_name, avatar_url, broadcaster_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [verifiedUser.login, email.trim(), tcg_url?.trim() || null, message?.trim() || null, ip, verifiedUser.id, verifiedUser.display_name, verifiedUser.profile_image_url, verifiedUser.broadcaster_type || '']
    )
    console.log(`Nouvelle candidature streamer: ${twitch} (${email})`)

    // Notif Discord (best effort, n'empêche pas la réponse OK)
    const statutLabel = verifiedUser.broadcaster_type === 'partner' ? '🤝 Partenaire'
                      : verifiedUser.broadcaster_type === 'affiliate' ? '✅ Affilié'
                      : '⚠️ Non affilié'
    notifyDiscord({
      username: 'Karto',
      embeds: [{
        title: '🎴 Nouvelle candidature streamer',
        color: verifiedUser.broadcaster_type ? 0x9146ff : 0xeab308,
        thumbnail: { url: verifiedUser.profile_image_url },
        fields: [
          { name: 'Streamer', value: `**${verifiedUser.display_name}** ([twitch.tv/${verifiedUser.login}](https://twitch.tv/${verifiedUser.login}))`, inline: false },
          { name: 'Statut Twitch', value: statutLabel, inline: true },
          { name: 'Email',  value: email.trim(),  inline: true },
          { name: 'TCG',    value: tcg_url?.trim() || '—', inline: false },
          { name: 'Message', value: (message?.trim() || '—').slice(0, 1000), inline: false }
        ],
        footer: { text: 'Approuve sur karto.live/admin' },
        timestamp: new Date().toISOString()
      }]
    })

    res.json({ ok: true })
  } catch(e) {
    console.error('Erreur contact:', e.message)
    res.status(500).json({ error: 'Erreur serveur.' })
  }
})


// api streamers

app.get('/api/streamers', (req, res) => {
  const liste = Object.entries(streamers).map(([id, { config, sets }]) => ({
    id,
    nom:         config.nom,
    couleur:     config.couleur,
    couleur2:    config.couleur2,
    description: config.description,
    sets: Object.entries(sets).map(([setId, { config: sc }]) => ({
      id:          setId,
      nom:         sc.nom,
      description: sc.description,
      date:        sc.date,
      couleur:     sc.couleur
    }))
  }))
  res.json(liste)
})

app.get('/api/streamer/:id/set/:setId/config', (req, res) => {
  const set = streamers[req.params.id]?.sets[req.params.setId]
  if (!set) return res.status(404).json({ error: 'not found' })
  res.json(set.config)
})

app.get('/api/streamer/:id/set/:setId/cards', (req, res) => {
  const set = streamers[req.params.id]?.sets[req.params.setId]
  if (!set) return res.status(404).json({ error: 'not found' })
  res.json(set.cards)
})


// collection

app.get('/api/collection/:viewerId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT streamer_id, set_id, carte_id, quantite FROM viewer_cards WHERE viewer_id = $1',
      [req.params.viewerId]
    )
    const col = {}
    rows.forEach(r => {
      if (!col[r.streamer_id]) col[r.streamer_id] = {}
      if (!col[r.streamer_id][r.set_id]) col[r.streamer_id][r.set_id] = {}
      col[r.streamer_id][r.set_id][r.carte_id] = r.quantite
    })
    res.json(col)
  } catch(e) { console.error('GET /api/collection:', e); res.status(500).json({ error: e.message }) }
})

app.post('/api/streamer/:id/set/:setId/collection/:viewerId', writeLimiter, viewerAuth, async (req, res) => {
  const { cartes } = req.body
  const { id: streamerId, setId, viewerId } = req.params

  if (!Array.isArray(cartes)) return res.status(400).json({ error: 'cartes[] requis' })
  if (!streamers[streamerId]?.sets[setId]) return res.status(404).json({ error: 'not found' })

  const count = {}
  cartes.forEach(id => { count[id] = (count[id] || 0) + 1 })

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const [carteId, nb] of Object.entries(count)) {
      await client.query(`
        INSERT INTO viewer_cards (viewer_id, streamer_id, set_id, carte_id, quantite)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (viewer_id, streamer_id, set_id, carte_id)
        DO UPDATE SET quantite = viewer_cards.quantite + excluded.quantite
      `, [viewerId, streamerId, setId, carteId, nb])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  res.json({ ok: true })
})


// packs (inventaire)

app.get('/api/packs/:viewerId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT streamer_id, set_id, booster_type, quantite FROM viewer_packs WHERE viewer_id = $1 AND quantite > 0',
      [req.params.viewerId]
    )
    const inv = {}
    rows.forEach(r => {
      if (!inv[r.streamer_id]) inv[r.streamer_id] = {}
      if (!inv[r.streamer_id][r.set_id]) inv[r.streamer_id][r.set_id] = {}
      inv[r.streamer_id][r.set_id][r.booster_type] = r.quantite
    })
    res.json(inv)
  } catch(e) { console.error('GET /api/packs:', e); res.status(500).json({ error: e.message }) }
})

app.post('/api/packs/:viewerId/add', writeLimiter, viewerAuth, async (req, res) => {
  try {
    const { streamerId, setId, boosterType, quantite = 1 } = req.body
    if (!streamerId || !setId || !boosterType) return res.status(400).json({ error: 'champs manquants' })

    await db.query(`
      INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
      DO UPDATE SET quantite = viewer_packs.quantite + excluded.quantite
    `, [req.params.viewerId, streamerId, setId, boosterType, quantite])

    res.json({ ok: true })
  } catch(e) { console.error('POST /api/packs/add:', e); res.status(500).json({ error: e.message }) }
})

app.post('/api/packs/:viewerId/use', writeLimiter, viewerAuth, async (req, res) => {
  try {
    const { streamerId, setId, boosterType } = req.body
    const { rows } = await db.query(
      'SELECT quantite FROM viewer_packs WHERE viewer_id = $1 AND streamer_id = $2 AND set_id = $3 AND booster_type = $4',
      [req.params.viewerId, streamerId, setId, boosterType]
    )

    if (!rows[0] || rows[0].quantite < 1) {
      return res.status(400).json({ error: 'aucun pack dispo' })
    }

    await db.query(
      'UPDATE viewer_packs SET quantite = quantite - 1 WHERE viewer_id = $1 AND streamer_id = $2 AND set_id = $3 AND booster_type = $4',
      [req.params.viewerId, streamerId, setId, boosterType]
    )

    res.json({ ok: true })
  } catch(e) { console.error('POST /api/packs/use:', e); res.status(500).json({ error: e.message }) }
})


// essence (désenchantement + rachat)

app.get('/api/essence/:viewerId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT streamer_id, set_id, quantite FROM viewer_essence WHERE viewer_id = $1',
      [req.params.viewerId]
    )
    const e = {}
    rows.forEach(r => {
      if (!e[r.streamer_id]) e[r.streamer_id] = {}
      e[r.streamer_id][r.set_id] = r.quantite
    })
    res.json(e)
  } catch(e2) { console.error('GET /api/essence:', e2); res.status(500).json({ error: e2.message }) }
})

// désenchanter des doublons : body { carteId, nb }
app.post('/api/streamer/:id/set/:setId/desenchanter/:viewerId', writeLimiter, viewerAuth, async (req, res) => {
  const { id: streamerId, setId, viewerId } = req.params
  const { carteId, nb = 1 } = req.body

  const set = streamers[streamerId]?.sets[setId]
  if (!set) return res.status(404).json({ error: 'set introuvable' })

  const carte = set.cards.find(c => c.id === carteId)
  if (!carte) return res.status(404).json({ error: 'carte introuvable' })

  const essenceParCarte = set.config.raretes?.[carte.rarete]?.essence || 5

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      'SELECT quantite FROM viewer_cards WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3 AND carte_id=$4',
      [viewerId, streamerId, setId, carteId]
    )
    const qte = rows[0]?.quantite || 0
    const doublons = qte - 1

    if (doublons < nb) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `doublons insuffisants (min 1 gardé)` })
    }

    const nouvelleQte = qte - nb
    await client.query(
      'UPDATE viewer_cards SET quantite=$1 WHERE viewer_id=$2 AND streamer_id=$3 AND set_id=$4 AND carte_id=$5',
      [nouvelleQte, viewerId, streamerId, setId, carteId]
    )

    const essenceGagnee = essenceParCarte * nb
    await client.query(`
      INSERT INTO viewer_essence (viewer_id, streamer_id, set_id, quantite)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (viewer_id, streamer_id, set_id)
      DO UPDATE SET quantite = viewer_essence.quantite + $4
    `, [viewerId, streamerId, setId, essenceGagnee])

    await client.query('COMMIT')

    const { rows: essRows } = await client.query(
      'SELECT quantite FROM viewer_essence WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3',
      [viewerId, streamerId, setId]
    )

    res.json({ ok: true, restant: nouvelleQte, essence: essRows[0]?.quantite || 0, gain: essenceGagnee })
  } catch(e) {
    await client.query('ROLLBACK')
    console.error('desenchanter:', e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// racheter une carte avec de l'essence
app.post('/api/streamer/:id/set/:setId/racheter/:viewerId', writeLimiter, viewerAuth, async (req, res) => {
  const { id: streamerId, setId, viewerId } = req.params
  const { carteId } = req.body

  const set = streamers[streamerId]?.sets[setId]
  if (!set) return res.status(404).json({ error: 'set introuvable' })

  const carte = set.cards.find(c => c.id === carteId)
  if (!carte) return res.status(404).json({ error: 'carte introuvable' })

  const cout = set.config.raretes?.[carte.rarete]?.essence_rachat || (set.config.raretes?.[carte.rarete]?.essence || 5) * 4

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows: essRows } = await client.query(
      'SELECT quantite FROM viewer_essence WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3',
      [viewerId, streamerId, setId]
    )
    const essence = essRows[0]?.quantite || 0
    if (essence < cout) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `essence insuffisante (${essence}/${cout})` })
    }

    await client.query(
      'UPDATE viewer_essence SET quantite=quantite-$1 WHERE viewer_id=$2 AND streamer_id=$3 AND set_id=$4',
      [cout, viewerId, streamerId, setId]
    )
    await client.query(`
      INSERT INTO viewer_cards (viewer_id, streamer_id, set_id, carte_id, quantite)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (viewer_id, streamer_id, set_id, carte_id)
      DO UPDATE SET quantite = viewer_cards.quantite + 1
    `, [viewerId, streamerId, setId, carteId])

    await client.query('COMMIT')

    const { rows: newEss } = await client.query(
      'SELECT quantite FROM viewer_essence WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3',
      [viewerId, streamerId, setId]
    )
    res.json({ ok: true, essence: newEss[0]?.quantite || 0 })
  } catch(e) {
    await client.query('ROLLBACK')
    console.error('racheter:', e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})


// acheter un booster avec de l'essence : body { boosterType }
app.post('/api/streamer/:id/set/:setId/acheterBooster/:viewerId', writeLimiter, viewerAuth, async (req, res) => {
  const { id: streamerId, setId, viewerId } = req.params
  const { boosterType } = req.body

  const set = streamers[streamerId]?.sets[setId]
  if (!set) return res.status(404).json({ error: 'set introuvable' })

  const booster = set.config.boosters?.[boosterType]
  if (!booster) return res.status(404).json({ error: 'booster introuvable' })

  const cout = booster.cout_essence
  if (!cout || cout <= 0) return res.status(400).json({ error: 'booster non rachetable avec essence' })

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows: essRows } = await client.query(
      'SELECT quantite FROM viewer_essence WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3',
      [viewerId, streamerId, setId]
    )
    const essence = essRows[0]?.quantite || 0
    if (essence < cout) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `essence insuffisante (${essence}/${cout})` })
    }

    await client.query(
      'UPDATE viewer_essence SET quantite=quantite-$1 WHERE viewer_id=$2 AND streamer_id=$3 AND set_id=$4',
      [cout, viewerId, streamerId, setId]
    )
    await client.query(`
      INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
      DO UPDATE SET quantite = viewer_packs.quantite + 1
    `, [viewerId, streamerId, setId, boosterType])

    await client.query('COMMIT')

    const { rows: newEss } = await client.query(
      'SELECT quantite FROM viewer_essence WHERE viewer_id=$1 AND streamer_id=$2 AND set_id=$3',
      [viewerId, streamerId, setId]
    )
    res.json({ ok: true, essence: newEss[0]?.quantite || 0 })
  } catch(e) {
    await client.query('ROLLBACK')
    console.error('acheterBooster:', e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})


// SSE — notifications temps réel vers le frontend
const sseClients = new Map() // viewerId -> [res, ...]

app.get('/events', async (req, res) => {
  const viewerId = req.query.viewerId
  const token    = req.query.token
  if (!viewerId) return res.status(400).end()

  // Vérifier que le token correspond au viewerId
  if (token) {
    try {
      const v = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `OAuth ${token}` }
      })
      if (!v.ok) return res.status(401).end()
      const data = await v.json()
      if (data.user_id !== viewerId) return res.status(403).end()
    } catch { return res.status(401).end() }
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (!sseClients.has(viewerId)) sseClients.set(viewerId, [])
  sseClients.get(viewerId).push(res)

  const keepalive = setInterval(() => res.write(': ping\n\n'), 30000)

  req.on('close', () => {
    clearInterval(keepalive)
    const list = sseClients.get(viewerId) || []
    const idx  = list.indexOf(res)
    if (idx !== -1) list.splice(idx, 1)
    if (!list.length) sseClients.delete(viewerId)
  })
})

function pushSSE(viewerId, payload) {
  const clients = sseClients.get(String(viewerId)) || []
  const data = `data: ${JSON.stringify(payload)}\n\n`
  clients.forEach(r => { try { r.write(data) } catch(_) {} })
}


// Déduplication des messages Twitch (évite double-traitement si Twitch renvoie le même event)
const processedMsgIds = new Set()
setInterval(() => { if (processedMsgIds.size > 1000) processedMsgIds.clear() }, 60 * 60 * 1000)

// Webhook Twitch
app.post('/webhook', async (req, res) => {
  const msgType = req.headers['twitch-eventsub-message-type']
  const sig     = req.headers['twitch-eventsub-message-signature']
  const msgId   = req.headers['twitch-eventsub-message-id']
  const ts      = req.headers['twitch-eventsub-message-timestamp']

  if (!msgId || !ts || !sig || !req.rawBody) return res.status(400).send('Bad Request')

  // 1. Signature en PREMIER (avant tout traitement)
  const toSign  = msgId + ts + req.rawBody
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(toSign).digest('hex')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(403).send('Forbidden')
  }

  // 2. Dédup APRÈS signature (sinon un faux msgId avec mauvaise sig pourrait "verrouiller" un vrai msgId)
  if (processedMsgIds.has(msgId)) {
    console.log(`[webhook] message dupliqué ignoré: ${msgId}`)
    return res.status(200).send('ok')
  }

  if (msgType === 'webhook_callback_verification') {
    processedMsgIds.add(msgId)
    return res.status(200).send(req.body.challenge)
  }

  if (msgType === 'notification') {
    const event  = req.body.event
    const title  = (event.reward?.title || '').toLowerCase()
    const cost   = event.reward?.cost
    const userId = event.user_id
    const rewardId = event.reward?.id || null

    console.log(`[reward] id=${rewardId} title="${event.reward?.title}" cost=${cost}`)

    // Trouver le streamer + set
    let streamerId = null
    let setId      = null
    let setData    = null

    const login = event.broadcaster_user_login?.toLowerCase()
    const sid   = login ? twitchToStreamer[login] : null

    const sets = sid
      ? Object.entries(streamers[sid]?.sets || {}).map(([k,v]) => [k,{...v, _sid: sid}])
      : Object.entries(streamers).flatMap(([s, st]) => Object.entries(st.sets || {}).map(([k,v]) => [k,{...v, _sid: s}]))

    for (const [k, s] of sets) {
      if (s.config.reward_id && s.config.reward_id === rewardId) {
        setId = k; setData = s; streamerId = s._sid; break
      }
    }
    if (!setId) {
      for (const [k, s] of sets) {
        if (!s.config.reward_id && (title.includes(s.config.nom?.toLowerCase()) || title.includes(k))) {
          setId = k; setData = s; streamerId = s._sid; break
        }
      }
    }

    if (!setId) {
      console.log(`[webhook] aucun set trouvé pour reward "${event.reward?.title}" (id=${rewardId})`)
      processedMsgIds.add(msgId) // rien à réessayer
      return res.status(200).send('ok')
    }

    // Trouver le booster correspondant au coût
    let boosterKey = null
    for (const [bk, bc] of Object.entries(setData.config.boosters || {})) {
      if (bc.cout === cost) { boosterKey = bk; break }
    }
    if (!boosterKey) {
      const sorted = Object.entries(setData.config.boosters || {}).sort((a,b) => a[1].cout - b[1].cout)
      if (sorted.length) { boosterKey = sorted[0][0] }
    }

    if (!boosterKey) {
      console.log('[webhook] aucun booster configuré pour ce set')
      processedMsgIds.add(msgId)
      return res.status(200).send('ok')
    }

    // 3. Créditer le pack — AWAIT la DB avant de répondre 200.
    // Si la DB pète, on renvoie 500 → Twitch retentera (jusqu'à 3x avec backoff)
    try {
      await db.query(`
        INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
        VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
        DO UPDATE SET quantite = viewer_packs.quantite + 1
      `, [userId, streamerId, setId, boosterKey])

      processedMsgIds.add(msgId) // commit DB OK → safe de dédup
      console.log(`[webhook] +1 ${boosterKey} → viewer ${userId} (${streamerId}/${setId})`)

      // Notif temps réel (best-effort, pas critique si SSE est down)
      try { pushSSE(userId, { type: 'pack_recu', streamerId, setId, booster: boosterKey }) } catch(_) {}
    } catch(e) {
      console.error('[webhook] erreur DB credit, Twitch retentera:', e.message)
      return res.status(500).send('DB error')
    }

    // 4. Marquer la redemption FULFILLED sur Twitch — fire-and-forget (nice-to-have)
    ;(async () => {
      try {
        if (!twitchUserToken) return
        const patchRedemption = (token) => fetch(
          `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${event.broadcaster_user_id}&reward_id=${rewardId}&id=${event.id}`,
          {
            method: 'PATCH',
            headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'FULFILLED' })
          }
        )
        let patchRes = await patchRedemption(twitchUserToken)
        if (patchRes.status === 401) {
          console.log('[reward] token expiré, refresh...')
          const ok = await refreshTwitchToken()
          if (ok) patchRes = await patchRedemption(twitchUserToken)
        }
        if (!patchRes.ok) {
          const err = await patchRes.json().catch(() => ({}))
          console.log(`[reward] PATCH redemption: ${patchRes.status}`, err)
        } else {
          console.log('[reward] redemption marquée FULFILLED')
        }
      } catch(e) { console.log('[reward] PATCH erreur:', e.message) }
    })()
  }

  res.status(200).send('ok')
})


// ─── Admin ────────────────────────────────────────────────────────────────────

async function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Token manquant' })
  try {
    // /oauth2/validate ne nécessite pas de Client-Id correspondant
    const r = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    })
    if (!r.ok) return res.status(401).json({ error: 'Token invalide' })
    const data = await r.json()
    if (!data.user_id || !ADMIN_IDS.has(data.user_id)) return res.status(403).json({ error: 'Accès refusé' })
    req.adminUser  = { id: data.user_id, login: data.login, display_name: data.login }
    req.adminToken = token
    next()
  } catch(e) { res.status(500).json({ error: e.message }) }
}

// Vérifie que le token Twitch appartient bien au viewerId passé en URL
async function viewerAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Token manquant' })
  try {
    const r = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    })
    if (!r.ok) return res.status(401).json({ error: 'Token invalide' })
    const data = await r.json()
    if (!data.user_id || data.user_id !== req.params.viewerId) {
      return res.status(403).json({ error: 'Accès refusé' })
    }
    req.viewerId = data.user_id
    next()
  } catch(e) { res.status(500).json({ error: e.message }) }
}

async function streamerAdminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Token manquant' })
  try {
    const r = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    })
    if (!r.ok) return res.status(401).json({ error: 'Token invalide' })
    const data = await r.json()
    const { rows } = await db.query('SELECT streamer_id FROM streamer_admins WHERE twitch_id = $1', [data.user_id])
    if (!rows[0]) return res.status(403).json({ error: 'Accès refusé' })
    req.streamerId = rows[0].streamer_id
    next()
  } catch(e) { res.status(500).json({ error: e.message }) }
}

async function appToken() {
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET })
  })
  return (await r.json()).access_token
}

// ── Rôle utilisateur (pas d'auth stricte — retourne le rôle selon le token) ──
app.get('/api/me/role', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.json({ isAdmin: false, streamerId: null, user: null })
  try {
    const r = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    })
    if (!r.ok) return res.json({ isAdmin: false, streamerId: null, user: null })
    const data = await r.json()
    const isAdmin = ADMIN_IDS.has(data.user_id)
    const { rows } = await db.query('SELECT streamer_id FROM streamer_admins WHERE twitch_id = $1', [data.user_id])
    const streamerId = rows[0]?.streamer_id || null
    res.json({ isAdmin, streamerId, user: { id: data.user_id, login: data.login } })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Vérifier si l'utilisateur est admin
app.get('/api/admin/check', adminAuth, (req, res) => {
  res.json({ ok: true, user: req.adminUser })
})

// ── EventSub ──
app.get('/api/admin/eventsub', adminAuth, async (req, res) => {
  try {
    const tok = await appToken()
    const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    res.json(await r.json())
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/eventsub', adminAuth, async (req, res) => {
  try {
    const { broadcaster_id } = req.body
    if (!broadcaster_id) return res.status(400).json({ error: 'broadcaster_id requis' })
    const tok = await appToken()
    const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: broadcaster_id },
        transport: { method: 'webhook', callback: CALLBACK_URL, secret: WEBHOOK_SECRET }
      })
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json(data)
    res.json(data)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/eventsub/:id', adminAuth, async (req, res) => {
  try {
    const tok = await appToken()
    const r = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${req.params.id}`, {
      method: 'DELETE',
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    res.json({ ok: r.ok || r.status === 404 })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Streamers ──
app.get('/api/admin/streamers-full', adminAuth, (req, res) => {
  const liste = Object.entries(streamers).map(([id, { config, sets }]) => ({
    id, config,
    sets: Object.entries(sets).map(([setId, { config: sc, cards }]) => ({
      id: setId, config: sc, nb_cartes: cards.length
    }))
  }))
  res.json(liste)
})

app.post('/api/admin/streamers', adminAuth, async (req, res) => {
  try {
    const twitch_login = sanitize(req.body.twitch_login, 50)
    const nom = sanitize(req.body.nom, 100)
    const couleur = req.body.couleur && isValidColor(req.body.couleur) ? req.body.couleur : '#6441a5'
    const couleur2 = req.body.couleur2 && isValidColor(req.body.couleur2) ? req.body.couleur2 : '#4b2d83'
    const description = sanitize(req.body.description, 500)
    if (!twitch_login) return res.status(400).json({ error: 'twitch_login requis' })

    const tok = await appToken()
    const r = await fetch(`https://api.twitch.tv/helix/users?login=${twitch_login}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    const data = await r.json()
    const twitchUser = data.data?.[0]
    if (!twitchUser) return res.status(404).json({ error: 'Streamer Twitch introuvable' })

    const id = twitch_login.toLowerCase().replace(/[^a-z0-9_]/g, '')
    const config = {
      id, nom: nom || twitchUser.display_name,
      couleur: couleur || '#6441a5', couleur2: couleur2 || '#4b2d83',
      description: description || '',
      twitch_login: twitch_login.toLowerCase(),
      twitch_id: twitchUser.id,
      avatar: twitchUser.profile_image_url
    }

    // Filesystem (best effort — peut être éphémère sur Render)
    try {
      const dir = path.join('streamers', id)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
    } catch(_) {}

    // DB (persistant)
    await db.query(
      'INSERT INTO streamers_config (id, config) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET config = $2',
      [id, JSON.stringify(config)]
    )

    // Lier le streamer à son compte Twitch (streamer_admins)
    await db.query(
      'INSERT INTO streamer_admins (streamer_id, twitch_id) VALUES ($1, $2) ON CONFLICT (twitch_id) DO UPDATE SET streamer_id = $1',
      [id, twitchUser.id]
    )

    // Mémoire
    if (!streamers[id]) streamers[id] = { config, sets: {} }
    else streamers[id].config = config
    twitchToStreamer[config.twitch_login] = id

    res.json({ ok: true, id, config, twitch: twitchUser })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Supprimer streamer ──
app.delete('/api/admin/streamers/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params
    // DB
    await db.query('DELETE FROM streamers_config WHERE id = $1', [id])
    await db.query('DELETE FROM sets_config WHERE streamer_id = $1', [id])
    // Mémoire
    delete streamers[id]
    for (const [login, sid] of Object.entries(twitchToStreamer)) {
      if (sid === id) delete twitchToStreamer[login]
    }
    // Filesystem (best effort)
    try {
      const dir = path.join('streamers', id)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    } catch(_) {}
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Sets ──
app.post('/api/admin/streamer/:id/sets', adminAuth, async (req, res) => {
  try {
    const { id } = req.params
    if (!streamers[id]) return res.status(404).json({ error: 'Streamer introuvable' })
    const set_id = sanitize(req.body.set_id, 50).toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const nom = sanitize(req.body.nom, 100)
    const description = sanitize(req.body.description, 500)
    const couleur = req.body.couleur && isValidColor(req.body.couleur) ? req.body.couleur : streamers[id].config.couleur
    if (!set_id || !nom) return res.status(400).json({ error: 'set_id et nom requis' })

    const config = {
      id: set_id, nom, description, date: '', couleur,
      boosters: {
        single: { nom: 'Booster', cout: 500, cout_essence: 100, nb_cartes: 10, garantie: null }
      },
      raretes: {
        'Commun':     { chance: 50, couleur: '#8a9bb0', essence: 5   },
        'Peu Commun': { chance: 30, couleur: '#4caf80', essence: 10  },
        'Rare':       { chance: 15, couleur: '#4a90d9', essence: 25  },
        'Épique':     { chance: 4,  couleur: '#9b59b6', essence: 75  },
        'Légendaire': { chance: 1,  couleur: '#f0a500', essence: 200 }
      }
    }

    try {
      const dir = path.join('streamers', id, 'sets', set_id)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
      fs.writeFileSync(path.join(dir, 'cards.json'), '[]')
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET config = $3',
      [id, set_id, JSON.stringify(config), '[]']
    )

    streamers[id].sets[set_id] = { config, cards: [] }
    res.json({ ok: true, config })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/streamer/:id/set/:setId', adminAuth, async (req, res) => {
  try {
    const { id, setId } = req.params
    await db.query('DELETE FROM sets_config WHERE streamer_id = $1 AND set_id = $2', [id, setId])
    if (streamers[id]) delete streamers[id].sets[setId]
    try {
      const dir = path.join('streamers', id, 'sets', setId)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    } catch(_) {}
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/streamer/:id/set/:setId/config', adminAuth, async (req, res) => {
  try {
    const { id, setId } = req.params
    const set = streamers[id]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })

    Object.assign(set.config, pickSetConfig(req.body))

    try {
      const cfgPath = path.join('streamers', id, 'sets', setId, 'config.json')
      if (fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, JSON.stringify(set.config, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET config = $3',
      [id, setId, JSON.stringify(set.config), JSON.stringify(set.cards || [])]
    )

    res.json({ ok: true, config: set.config })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Upload image ──
app.post('/api/upload', uploadLimiter, adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' })
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'karto', resource_type: 'image', transformation: [{ width: 800, height: 1120, crop: 'limit', quality: 'auto' }] },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(req.file.buffer)
    })
    res.json({ url: result.secure_url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/streamer-admin/upload', uploadLimiter, streamerAdminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' })
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'karto', resource_type: 'image', transformation: [{ width: 800, height: 1120, crop: 'limit', quality: 'auto' }] },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(req.file.buffer)
    })
    res.json({ url: result.secure_url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Cartes (admin) ──
app.post('/api/admin/streamer/:id/set/:setId/cards', adminAuth, async (req, res) => {
  try {
    const { id, setId } = req.params
    const set = streamers[id]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })

    const nom = sanitize(req.body.nom, 100)
    const rarete = sanitize(req.body.rarete, 50)
    const type = sanitize(req.body.type, 50)
    const image = sanitize(req.body.image, 500)
    if (!nom || !rarete) return res.status(400).json({ error: 'nom et rarete requis' })

    const cardId = nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '_') + '_' + Date.now()
    const card = { id: cardId, nom, rarete, type, image }

    set.cards.push(card)

    try {
      fs.writeFileSync(path.join('streamers', id, 'sets', setId, 'cards.json'), JSON.stringify(set.cards, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET cards = $4',
      [id, setId, JSON.stringify(set.config), JSON.stringify(set.cards)]
    )
    res.json({ ok: true, card })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/streamer/:id/set/:setId/card/:cardId', adminAuth, async (req, res) => {
  try {
    const { id, setId, cardId } = req.params
    const set = streamers[id]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })
    const idx = set.cards.findIndex(c => c.id === cardId)
    if (idx === -1) return res.status(404).json({ error: 'Carte introuvable' })

    set.cards.splice(idx, 1)

    try {
      fs.writeFileSync(path.join('streamers', id, 'sets', setId, 'cards.json'), JSON.stringify(set.cards, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET cards = $4',
      [id, setId, JSON.stringify(set.config), JSON.stringify(set.cards)]
    )
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Récompenses Twitch ──
app.get('/api/admin/streamer/:id/rewards', adminAuth, async (req, res) => {
  try {
    const s = streamers[req.params.id]
    if (!s) return res.status(404).json({ error: 'Streamer introuvable' })
    const twitchId = s.config.twitch_id
    if (!twitchId) return res.status(400).json({ error: 'twitch_id manquant dans la config' })
    const r = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${twitchId}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${twitchUserToken}` }
    })
    res.json(await r.json())
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Approuver une candidature ──
app.post('/api/admin/approve/:contactId', adminAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM contact_requests WHERE id = $1', [req.params.contactId])
    if (!rows[0]) return res.status(404).json({ error: 'Candidature introuvable' })
    const contact = rows[0]

    const tok = await appToken()
    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${contact.twitch}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    const twitchUser = (await userRes.json()).data?.[0]
    if (!twitchUser) return res.status(404).json({ error: 'Streamer Twitch introuvable' })

    const id = contact.twitch.toLowerCase().replace(/[^a-z0-9_]/g, '')
    const config = {
      id, nom: twitchUser.display_name,
      couleur: '#6441a5', couleur2: '#4b2d83',
      description: contact.message || '',
      twitch_login: contact.twitch.toLowerCase(),
      twitch_id: twitchUser.id,
      avatar: twitchUser.profile_image_url
    }

    try {
      const dir = path.join('streamers', id)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO streamers_config (id, config) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET config = $2',
      [id, JSON.stringify(config)]
    )
    if (!streamers[id]) streamers[id] = { config, sets: {} }
    else streamers[id].config = config
    twitchToStreamer[config.twitch_login] = id

    await db.query(
      'INSERT INTO streamer_admins (streamer_id, twitch_id) VALUES ($1, $2) ON CONFLICT (twitch_id) DO UPDATE SET streamer_id = $1',
      [id, twitchUser.id]
    )

    await db.query('DELETE FROM contact_requests WHERE id = $1', [req.params.contactId])

    console.log(`Candidature approuvée: ${contact.twitch} → streamer ID: ${id}`)
    res.json({ ok: true, id, config })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Streamer admin : données propres ──
app.get('/api/streamer-admin/me', streamerAdminAuth, (req, res) => {
  const s = streamers[req.streamerId]
  if (!s) return res.status(404).json({ error: 'Streamer introuvable' })
  res.json({
    id: req.streamerId,
    config: s.config,
    sets: Object.entries(s.sets).map(([setId, { config: sc, cards }]) => ({
      id: setId, config: sc, nb_cartes: cards.length
    }))
  })
})

// ── Streamer admin : modifier config d'un set ──
app.patch('/api/streamer-admin/set/:setId/config', streamerAdminAuth, async (req, res) => {
  try {
    const { setId } = req.params
    const s = streamers[req.streamerId]
    const set = s?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })

    Object.assign(set.config, pickSetConfig(req.body))

    try {
      const cfgPath = path.join('streamers', req.streamerId, 'sets', setId, 'config.json')
      if (fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, JSON.stringify(set.config, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET config = $3',
      [req.streamerId, setId, JSON.stringify(set.config), JSON.stringify(set.cards || [])]
    )
    res.json({ ok: true, config: set.config })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Streamer admin : créer un set ──
app.post('/api/streamer-admin/sets', streamerAdminAuth, async (req, res) => {
  try {
    const s = streamers[req.streamerId]
    if (!s) return res.status(404).json({ error: 'Streamer introuvable' })

    const set_id = sanitize(req.body.set_id, 50).toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const nom = sanitize(req.body.nom, 100)
    const description = sanitize(req.body.description, 500)
    const couleur = req.body.couleur && isValidColor(req.body.couleur) ? req.body.couleur : s.config.couleur
    if (!set_id || !nom) return res.status(400).json({ error: 'set_id et nom requis' })
    if (s.sets[set_id]) return res.status(400).json({ error: 'Un set avec cet ID existe déjà' })

    const config = {
      id: set_id, nom, description, date: '', couleur,
      boosters: {
        single: { nom: 'Booster', cout: 500, cout_essence: 100, nb_cartes: 10, garantie: null }
      },
      raretes: {
        'Commun':     { chance: 50, couleur: '#8a9bb0', essence: 5   },
        'Peu Commun': { chance: 30, couleur: '#4caf80', essence: 10  },
        'Rare':       { chance: 15, couleur: '#4a90d9', essence: 25  },
        'Épique':     { chance: 4,  couleur: '#9b59b6', essence: 75  },
        'Légendaire': { chance: 1,  couleur: '#f0a500', essence: 200 }
      }
    }

    try {
      const dir = path.join('streamers', req.streamerId, 'sets', set_id)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
      fs.writeFileSync(path.join(dir, 'cards.json'), '[]')
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET config = $3',
      [req.streamerId, set_id, JSON.stringify(config), '[]']
    )

    s.sets[set_id] = { config, cards: [] }
    res.json({ ok: true, config })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Streamer admin : EventSub ──
app.get('/api/streamer-admin/eventsub', streamerAdminAuth, async (req, res) => {
  try {
    const s = streamers[req.streamerId]
    if (!s) return res.status(404).json({ error: 'Streamer introuvable' })
    const twitchId = s.config.twitch_id
    const tok = await appToken()
    const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    const data = await r.json()
    const subs = (data.data || []).filter(sub => sub.condition?.broadcaster_user_id === twitchId)
    res.json({ data: subs })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/streamer-admin/eventsub', streamerAdminAuth, async (req, res) => {
  try {
    const s = streamers[req.streamerId]
    if (!s) return res.status(404).json({ error: 'Streamer introuvable' })
    const twitchId = s.config.twitch_id
    if (!twitchId) return res.status(400).json({ error: 'twitch_id manquant dans la config' })
    const tok = await appToken()
    const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: twitchId },
        transport: { method: 'webhook', callback: CALLBACK_URL, secret: WEBHOOK_SECRET }
      })
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || data.error || 'Erreur Twitch', detail: data })
    res.json(data)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/streamer-admin/eventsub/:id', streamerAdminAuth, async (req, res) => {
  try {
    const tok = await appToken()
    const r = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${req.params.id}`, {
      method: 'DELETE',
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tok}` }
    })
    res.json({ ok: r.ok || r.status === 404 })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Streamer admin : cartes ──
app.get('/api/streamer-admin/set/:setId/cards', streamerAdminAuth, (req, res) => {
  const set = streamers[req.streamerId]?.sets[req.params.setId]
  if (!set) return res.status(404).json({ error: 'Set introuvable' })
  res.json(set.cards || [])
})

app.post('/api/streamer-admin/set/:setId/cards', streamerAdminAuth, async (req, res) => {
  try {
    const { setId } = req.params
    const set = streamers[req.streamerId]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })

    const nom = sanitize(req.body.nom, 100)
    const rarete = sanitize(req.body.rarete, 50)
    const image = sanitize(req.body.image, 500)
    if (!nom || !rarete) return res.status(400).json({ error: 'nom et rarete requis' })

    const cardId = nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '_') + '_' + Date.now()
    const card = { id: cardId, nom, rarete, image }

    set.cards.push(card)

    try {
      fs.writeFileSync(path.join('streamers', req.streamerId, 'sets', setId, 'cards.json'), JSON.stringify(set.cards, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET cards = $4',
      [req.streamerId, setId, JSON.stringify(set.config), JSON.stringify(set.cards)]
    )
    res.json({ ok: true, card })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/streamer-admin/set/:setId/card/:cardId', streamerAdminAuth, async (req, res) => {
  try {
    const { setId, cardId } = req.params
    const set = streamers[req.streamerId]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })
    const card = set.cards.find(c => c.id === cardId)
    if (!card) return res.status(404).json({ error: 'Carte introuvable' })

    const { nom, rarete, image } = req.body
    if (nom)   card.nom   = nom.trim()
    if (rarete) card.rarete = rarete
    if (image !== undefined) card.image = image.trim()

    try {
      fs.writeFileSync(path.join('streamers', req.streamerId, 'sets', setId, 'cards.json'), JSON.stringify(set.cards, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET cards = $4',
      [req.streamerId, setId, JSON.stringify(set.config), JSON.stringify(set.cards)]
    )
    res.json({ ok: true, card })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/streamer-admin/set/:setId/card/:cardId', streamerAdminAuth, async (req, res) => {
  try {
    const { setId, cardId } = req.params
    const set = streamers[req.streamerId]?.sets[setId]
    if (!set) return res.status(404).json({ error: 'Set introuvable' })
    const idx = set.cards.findIndex(c => c.id === cardId)
    if (idx === -1) return res.status(404).json({ error: 'Carte introuvable' })

    set.cards.splice(idx, 1)

    try {
      fs.writeFileSync(path.join('streamers', req.streamerId, 'sets', setId, 'cards.json'), JSON.stringify(set.cards, null, 2))
    } catch(_) {}

    await db.query(
      'INSERT INTO sets_config (streamer_id, set_id, config, cards) VALUES ($1, $2, $3, $4) ON CONFLICT (streamer_id, set_id) DO UPDATE SET cards = $4',
      [req.streamerId, setId, JSON.stringify(set.config), JSON.stringify(set.cards)]
    )
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Candidatures ──
app.get('/api/admin/contacts', adminAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM contact_requests ORDER BY created_at DESC LIMIT 100')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/contacts/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM contact_requests WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Pages ──
// ── Page publique streamer ───────────────────────────────────────────────────
let publicTemplate = null
app.get('/c/:streamerId', (req, res) => {
  const s = streamers[req.params.streamerId]
  if (!s) return res.status(404).send('Streamer introuvable')
  if (!publicTemplate) publicTemplate = fs.readFileSync(path.resolve('public.html'), 'utf-8')
  const data = {
    id:           s.config.id,
    nom:          s.config.nom,
    description:  s.config.description || '',
    couleur:      s.config.couleur || '#9146ff',
    couleur2:     s.config.couleur2 || s.config.couleur || '#9146ff',
    avatar:       s.config.avatar || '',
    twitch_login: s.config.twitch_login || '',
    sets: Object.entries(s.sets).map(([setId, { config: sc, cards }]) => ({
      id:       setId,
      nom:      sc.nom,
      description: sc.description || '',
      couleur:  sc.couleur || '#888',
      raretes:  sc.raretes || {},
      cards:    (cards || []).map(c => ({ id: c.id, nom: c.nom, rarete: c.rarete, type: c.type || '', image: c.image }))
    }))
  }
  const html = publicTemplate
    .replace(/\{\{NOM\}\}/g,       data.nom)
    .replace(/\{\{ID\}\}/g,        data.id)
    .replace(/\{\{AVATAR\}\}/g,    data.avatar)
    .replace(/\{\{COULEUR2\}\}/g,  data.couleur2)
    .replace(/\{\{COULEUR\}\}/g,   data.couleur)
    .replace('{{DATA_JSON}}',     JSON.stringify(data).replace(/<\//g, '<\\/'))
  res.send(html)
})

app.get('/',      (_req, res) => res.sendFile(path.resolve('index.html')))
app.get('/app',   (_req, res) => res.sendFile(path.resolve('app.html')))
app.get('/admin', (_req, res) => res.sendFile(path.resolve('admin.html')))

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
initDB().then(() => {
  loadTokensFromDB()
  loadStreamersFromDB()
  http.createServer(app).listen(PORT, () => console.log(`Karto sur http://localhost:${PORT}`))
})
