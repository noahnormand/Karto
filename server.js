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
  console.log('db ok')
}


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
})

app.post('/api/packs/:viewerId/add', async (req, res) => {
  const { streamerId, setId, boosterType, quantite = 1 } = req.body
  if (!streamerId || !setId || !boosterType) return res.status(400).json({ error: 'champs manquants' })

  await db.query(`
    INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
    DO UPDATE SET quantite = viewer_packs.quantite + excluded.quantite
  `, [req.params.viewerId, streamerId, setId, boosterType, quantite])

  res.json({ ok: true })
})

app.post('/api/packs/:viewerId/use', async (req, res) => {
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
})


// sse

const connections = new Map()

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')

  const viewerId = req.query.viewerId || 'anon'
  if (!connections.has(viewerId)) connections.set(viewerId, [])
  connections.get(viewerId).push(res)

  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => {
    clearInterval(ping)
    const remaining = (connections.get(viewerId) || []).filter(r => r !== res)
    if (!remaining.length) connections.delete(viewerId)
    else connections.set(viewerId, remaining)
  })
})

function broadcast(viewerId, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  if (viewerId && connections.has(viewerId)) {
    connections.get(viewerId).forEach(r => r.write(data))
  } else {
    connections.forEach(list => list.forEach(r => r.write(data)))
  }
}


// webhook twitch

function verifyHmac(req) {
  if (!WEBHOOK_SECRET) return true // pas de secret configuré = on laisse passer (dev)
  const msgId     = req.headers['twitch-eventsub-message-id'] || ''
  const timestamp = req.headers['twitch-eventsub-message-timestamp'] || ''
  const sigHeader = req.headers['twitch-eventsub-message-signature'] || ''
  const expected  = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(msgId + timestamp + (req.rawBody || ''))
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader))
  } catch {
    return false
  }
}

app.post('/webhook', async (req, res) => {
  if (!verifyHmac(req)) return res.sendStatus(403)

  if (req.headers['twitch-eventsub-message-type'] === 'webhook_callback_verification') {
    return res.send(req.body.challenge)
  }

  const event    = req.body.event || {}
  const username = event.user_name || 'Quelqu\'un'
  const viewerId = event.user_id || null
  const cost     = event?.reward?.cost || 500
  const title    = (event?.reward?.title || '').toLowerCase()
  const login    = (event.broadcaster_user_login || '').toLowerCase()

  const streamerId = twitchToStreamer[login]
  const streamer   = streamerId ? streamers[streamerId] : null
  if (!streamer) return res.sendStatus(200)

  const sets = Object.entries(streamer.sets)
  let [setId, setData] = sets[0] || []

  for (const [sid, s] of sets) {
    if (title.includes(s.config.nom.toLowerCase()) || title.includes(sid)) {
      setId = sid; setData = s; break
    }
  }

  let boosterType = 'single'
  const boosters  = setData?.config?.boosters || {}
  if (boosters.display && cost >= boosters.display.cout) boosterType = 'display'
  else if (boosters.pack && cost >= boosters.pack.cout)  boosterType = 'pack'

  console.log(`${username} → ${cost}pts → ${streamerId}/${setId} (${boosterType})`)

  if (viewerId) {
    await db.query(`
      INSERT INTO viewer_packs (viewer_id, streamer_id, set_id, booster_type, quantite)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (viewer_id, streamer_id, set_id, booster_type)
      DO UPDATE SET quantite = viewer_packs.quantite + 1
    `, [viewerId, streamerId, setId, boosterType])
  }

  broadcast(viewerId, { type: 'pack_recu', booster: boosterType, streamerId, setId, utilisateur: username })
  res.sendStatus(200)
})


// démarrage

initDB().then(() => {
  if (prod) {
    const port = process.env.PORT || 3000
    http.createServer(app).listen(port, () => console.log(`http://localhost:${port}`))
  } else {
    const ssl = {
      key:  fs.readFileSync('key.pem'),
      cert: fs.readFileSync('cert.pem')
    }
    https.createServer(ssl, app).listen(3000, () => console.log('https://localhost:3000'))
    http.createServer(app).listen(3001, () => console.log('http://localhost:3001 (twitch cli)'))
  }
})
