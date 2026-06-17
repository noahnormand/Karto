// Lance ce script une seule fois pour créer la récompense Twitch et enregistrer le webhook EventSub.
// Prérequis : avoir lancé get_user_token.js d'abord
// Usage : node register_eventsub.js

require('dotenv').config()

const CLIENT_ID      = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET
const USER_TOKEN     = process.env.TWITCH_USER_TOKEN
const CALLBACK_URL   = process.env.CALLBACK_URL || 'https://karto-182e.onrender.com/webhook'

if (!CLIENT_ID || !CLIENT_SECRET || !BROADCASTER_ID || !WEBHOOK_SECRET) {
  console.error('Variables manquantes dans .env')
  process.exit(1)
}
if (!USER_TOKEN) {
  console.error('TWITCH_USER_TOKEN manquant. Lance d\'abord : node get_user_token.js')
  process.exit(1)
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
async function createReward(name, cost) {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER_ID}`, {
    method: 'POST',
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${USER_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ title: name, cost, is_enabled: true })
  })
  return res.json()
}

// Liste les récompenses existantes créées par l'app
async function listRewards() {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER_ID}&only_manageable_rewards=true`, {
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${USER_TOKEN}`
    }
  })
  return res.json()
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
    const appToken = await getAppToken()

    // node register_eventsub.js list
    if (process.argv[2] === 'list') {
      const list = await listEventSub(appToken)
      const rewards = await listRewards()
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

    // Vérifie les récompenses déjà créées par l'app
    console.log('Vérification des récompenses existantes...')
    const existing = await listRewards()
    let rewardId = null

    if (existing.data?.length > 0) {
      console.log('Récompenses gérées par l\'app :')
      existing.data.forEach(r => console.log(`  [${r.id}] "${r.title}" — ${r.cost} pts`))
      rewardId = existing.data[0].id
      console.log(`\nUtilisation de la récompense "${existing.data[0].title}" (${rewardId})`)
    } else {
      console.log('Aucune récompense existante, création d\'une nouvelle...')
      const reward = await createReward('Booster Karto', 500)
      if (reward.data?.[0]) {
        rewardId = reward.data[0].id
        console.log(`Récompense créée : "${reward.data[0].title}" (${rewardId})`)
        // Sauvegarde l'ID dans .env
        const fs = require('fs')
        let env = fs.readFileSync('.env', 'utf8')
        if (env.includes('TWITCH_REWARD_ID=')) {
          env = env.replace(/TWITCH_REWARD_ID=.*/, `TWITCH_REWARD_ID=${rewardId}`)
        } else {
          env += `\nTWITCH_REWARD_ID=${rewardId}`
        }
        fs.writeFileSync('.env', env)
      } else {
        console.error('Erreur création récompense:', JSON.stringify(reward))
        process.exit(1)
      }
    }

    console.log('\nEnregistrement EventSub...')
    const result = await registerEventSub(appToken, rewardId)
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
