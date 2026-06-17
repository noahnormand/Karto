// Lance ce script une seule fois pour créer la récompense Twitch et enregistrer le webhook EventSub.
// Prérequis : avoir lancé get_user_token.js d'abord
// Usage : node register_eventsub.js

require('dotenv').config()

const CLIENT_ID      = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET
const CALLBACK_URL   = process.env.CALLBACK_URL || 'https://karto-182e.onrender.com/webhook'

if (!CLIENT_ID || !CLIENT_SECRET || !BROADCASTER_ID || !WEBHOOK_SECRET) {
  console.error('Variables manquantes dans .env')
  process.exit(1)
}

// Retourne un user token valide : DB en priorité, sinon refresh depuis .env
async function getFreshUserToken() {
  // 1. Essayer de lire le token depuis la DB (le serveur le garde à jour)
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg')
      const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
      const { rows } = await db.query("SELECT value FROM karto_config WHERE key = 'TWITCH_USER_TOKEN'")
      await db.end()
      if (rows[0]?.value) {
        const v = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: { 'Authorization': `OAuth ${rows[0].value}` }
        })
        if (v.ok) return rows[0].value
      }
    } catch (_) {}
  }

  // 2. Token du .env
  const current = process.env.TWITCH_USER_TOKEN
  if (current) {
    const v = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${current}` }
    })
    if (v.ok) return current
  }

  // 3. Refresh
  const refresh = process.env.TWITCH_REFRESH_TOKEN
  if (!refresh) {
    console.error('Token expiré et TWITCH_REFRESH_TOKEN absent du .env')
    console.error('Relance : node get_user_token.js')
    process.exit(1)
  }

  console.log('Token expiré, refresh en cours...')
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refresh,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  })
  const data = await r.json()
  if (!data.access_token) {
    console.error('Refresh échoué :', data)
    console.error('Relance : node get_user_token.js')
    process.exit(1)
  }

  // Mettre à jour le .env
  const fs = require('fs')
  let env  = fs.readFileSync('.env', 'utf-8')
  env = env.replace(/^TWITCH_USER_TOKEN=.*/m,    `TWITCH_USER_TOKEN=${data.access_token}`)
  env = env.replace(/^TWITCH_REFRESH_TOKEN=.*/m, `TWITCH_REFRESH_TOKEN=${data.refresh_token}`)
  fs.writeFileSync('.env', env)
  console.log('✓ Token rafraîchi et .env mis à jour')
  return data.access_token
}

async function getAppToken() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(JSON.stringify(data))
  return data.access_token
}

// Crée la récompense via l'API (avec user token) → l'app en est propriétaire
async function createReward(userToken, name, cost) {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER_ID}`, {
    method: 'POST',
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${userToken}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ title: name, cost, is_enabled: true })
  })
  return res.json()
}

// Liste les récompenses existantes créées par l'app
async function listRewards(userToken) {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER_ID}&only_manageable_rewards=true`, {
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${userToken}`
    }
  })
  return res.json()
}

// Liste TOUTES les récompenses d'un broadcaster (y compris manuelles)
async function listAllRewards(broadcasterId, userToken) {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${userToken}`
    }
  })
  return res.json()
}

// Récupère le broadcaster_id depuis un login twitch
async function getBroadcasterId(appToken, login) {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${appToken}` }
  })
  const data = await res.json()
  return data.data?.[0]?.id || null
}

async function registerEventSub(appToken, rewardId) {
  const condition = rewardId
    ? { broadcaster_user_id: BROADCASTER_ID, reward_id: rewardId }
    : { broadcaster_user_id: BROADCASTER_ID }

  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${appToken}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      type:    'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition,
      transport: {
        method:   'webhook',
        callback: CALLBACK_URL,
        secret:   WEBHOOK_SECRET
      }
    })
  })
  return res.json()
}

async function listEventSub(appToken) {
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${appToken}` }
  })
  return res.json()
}

async function deleteEventSub(appToken, id) {
  const res = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${id}`, {
    method: 'DELETE',
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${appToken}` }
  })
  return res.status
}

;(async () => {
  try {
    console.log('Obtention du token app...')
    const appToken  = await getAppToken()
    const userToken = await getFreshUserToken()

    // node register_eventsub.js rewards
    if (process.argv[2] === 'rewards') {
      const fs   = require('fs')
      const path = require('path')
      const streamersDir = path.join(__dirname, 'streamers')
      const streamerIds  = fs.existsSync(streamersDir) ? fs.readdirSync(streamersDir) : []

      for (const id of streamerIds) {
        const configPath = path.join(streamersDir, id, 'config.json')
        if (!fs.existsSync(configPath)) continue
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        const login  = config.twitch_login

        console.log(`\n${config.nom} (${id})${login ? ` — @${login}` : ''}`)

        if (!login) { console.log('  ⚠ pas de twitch_login dans config.json'); continue }

        const bid = await getBroadcasterId(appToken, login)
        if (!bid) { console.log('  ⚠ broadcaster introuvable'); continue }

        const result = await listAllRewards(bid, userToken)
        if (result.error) { console.log(`  ⚠ ${result.message}`); continue }

        const rewards = result.data || []
        if (!rewards.length) { console.log('  (aucune récompense)'); continue }

        rewards.forEach(r => {
          console.log(`  "${r.title}" : "${r.id}"  [${r.cost} pts${r.is_enabled ? '' : ' — désactivée'}]`)
        })
      }
      return
    }

    // node register_eventsub.js list
    if (process.argv[2] === 'list') {
      const list = await listEventSub(appToken)
      const rewards = await listRewards(userToken)
      const rewardNames = {}
      rewards.data?.forEach(r => { rewardNames[r.id] = r.title })
      list.data?.forEach(s => {
        const rid = s.condition.reward_id
        const rname = rid ? (rewardNames[rid] || rid) : 'any'
        console.log(`  [${s.id}] broadcaster=${s.condition.broadcaster_user_id} reward="${rname}" [${s.status}]`)
      })
      return
    }

    // node register_eventsub.js delete <id>
    if (process.argv[2] === 'delete') {
      const id = process.argv[3]
      if (!id) { console.error('Usage: node register_eventsub.js delete <id>'); process.exit(1) }
      const status = await deleteEventSub(appToken, id)
      console.log(status === 204 ? `Subscription ${id} supprimée.` : `Erreur: status ${status}`)
      return
    }

    // Écoute toutes les récompenses de la chaîne (sans filtre reward_id)
    // Le streamer crée sa propre récompense avec le coût qu'il veut
    console.log('\nEnregistrement EventSub (toutes récompenses)...')
    const result = await registerEventSub(appToken, null)
    console.log(JSON.stringify(result, null, 2))

    if (result.data?.[0]?.status === 'webhook_callback_verification_pending') {
      console.log('\n✓ Subscription enregistrée. Twitch va vérifier le webhook dans quelques secondes.')
      console.log('Vérifie les logs Render pour voir la confirmation.')
    } else if (result.error) {
      console.error('\nErreur:', result.message)
      if (result.status === 409) {
        console.log('Subscription déjà existante. Subscriptions actives :')
        const list = await listEventSub(appToken)
        list.data?.forEach(s => console.log(`  ${s.type} → ${s.transport.callback} [${s.status}]`))
      }
    }
  } catch (e) {
    console.error(e)
  }
})()
