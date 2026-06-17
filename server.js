require('dotenv').config()

const express  = require('express')
const https    = require('https')
const http     = require('http')
const fs       = require('fs')
const path     = require('path')
const crypto   = require('crypto')
const { Pool } = require('pg')

const app            = express()
const prod           = process.env.NODE_ENV === 'production'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID     || ''
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || ''
let   twitchUserToken      = process.env.TWITCH_USER_TOKEN    || ''
let   twitchRefreshToken   = process.env.TWITCH_REFRESH_TOKEN || ''

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
app.use(express.static('.'))

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

app.post('/api/contact', async (req, res) => {
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
    await db.query(
      'INSERT INTO contact_requests (twitch, email, tcg_url, message, ip) VALUES ($1, $2, $3, $4, $5)',
      [twitch.trim(), email.trim(), tcg_url?.trim() || null, message?.trim() || null, ip]
    )
    console.log(`Nouvelle candidature streamer: ${twitch} (${email})`)
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

app.post('/api/streamer/:id/set/:setId/collection/:viewerId', async (req, res) => {
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

app.post('/api/packs/:viewerId/add', async (req, res) => {
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

app.post('/api/packs/:viewerId/use', async (req, res) => {
  try {
    const { streamerId, setId, boosterType } = req.body
    const { rows } = await db.query(
      'SELECT quantite FROM viewer_packs WHERE viewer_id = $1 AND streamer_id = $2 AND set_id = $3 AND booster_type = $4',
      [req.params.viewerId, streamerId, setId, boosterType]
    )

    if (!rows[0] || rows[0].quantite < 1) return res.status(400).json({ error: 'aucun pack dispo' })

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
app.post('/api/streamer/:id/set/:setId/desenchanter/:viewerId', async (req, res) => {
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

    res.json({ ok: true, restant: nouvelleQte, essence: essRows[0]?.quantite || 0 })
  } catch(e) {
    await client.query('ROLLBACK')
    console.error('desenchanter:', e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// racheter une carte avec de l'essence
app.post('/api/streamer/:id/set/:setId/racheter/:viewerId', async (req, res) => {
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


// SSE — notifications temps réel vers le frontend
const sseClients = new Map() // viewerId -> [res, ...]

app.get('/events', (req, res) => {
  const viewerId = req.query.viewerId
  if (!viewerId) return res.status(400).end()

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


// Webhook Twitch
app.post('/webhook', (req, res) => {
  const msgType = req.headers['twitch-eventsub-message-type']
  const sig     = req.headers['twitch-eventsub-message-signature']
  const msgId   = req.headers['twitch-eventsub-message-id']
  const ts      = req.headers['twitch-eventsub-message-timestamp']

  const toSign  = msgId + ts + req.rawBody
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(toSign).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected))) {
    return res.status(403).send('Forbidden')
  }

  if (msgType === 'webhook_callback_verification') {
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

    // Chercher d'abord par broadcaster_user_login
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
      return res.status(200).send('ok')
    }

    // Trouver le booster correspondant au coût
    let boosterKey = null
    let boosterCfg = null
    for (const [bk, bc] of Object.entries(setData.config.boosters || {})) {
      if (bc.cout === cost) { boosterKey = bk; boosterCfg = bc; break }
    }
    if (!boosterKey) {
      // Prendre le moins cher par défaut
      const sorted = Object.entries(setData.config.boosters || {}).sort((a,b) => a[1].cout - b[1].cout)
      if (sorted.length) { [boosterKey, boosterCfg] = sorted[0] }
    }

    if (!boosterKey) {
      console.log('[webhook] aucun booster configuré pour ce set')
      return res.status(200).send('ok')
    }

    // Créditer le pack
    ;(async () => {
      try {
        await db.query(`
          INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
          VALUES ($1, $2, $3, $4, 1)
          ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
          DO UPDATE SET quantite = viewer_packs.quantite + 1
        `, [userId, streamerId, setId, boosterKey])

        console.log(`[webhook] +1 ${boosterKey} → viewer ${userId} (${streamerId}/${setId})`)

        // Notifier le viewer en temps réel
        pushSSE(userId, { type: 'pack_recu', streamerId, setId, booster: boosterKey })

        // Marquer la récompense comme fulfillée
        const appTokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials'
          })
        })
        const appToken = (await appTokenRes.json()).access_token

        if (appToken && twitchUserToken) {
          const patchRes = await fetch(
            `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${event.broadcaster_user_id}&reward_id=${rewardId}&id=${event.id}`,
            {
              method: 'PATCH',
              headers: {
                'Client-Id': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${twitchUserToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ status: 'FULFILLED' })
            }
          )
          if (!patchRes.ok) {
            const err = await patchRes.json().catch(() => ({}))
            console.log(`[reward] PATCH redemption: ${patchRes.status}`, err)
          } else {
            console.log('[reward] redemption marquée FULFILLED')
          }
        }
      } catch(e) {
        console.error('[webhook] erreur DB:', e)
      }
    })()
  }

  res.status(200).send('ok')
})


const PORT = process.env.PORT || 3000
http.createServer(app).listen(PORT, () => console.log(`Karto sur http://localhost:${PORT}`))
