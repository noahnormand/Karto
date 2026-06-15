// Lance ce script une seule fois pour enregistrer la subscription EventSub Twitch.
// Prérequis : CLIENT_ID, CLIENT_SECRET, BROADCASTER_ID dans .env
// Usage : node register_eventsub.js

require('dotenv').config()

const CLIENT_ID      = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET
const CALLBACK_URL   = process.env.NODE_ENV === 'production'
  ? 'https://karto-182e.onrender.com/webhook'
  : process.env.CALLBACK_URL || 'https://localhost:3000/webhook'

if (!CLIENT_ID || !CLIENT_SECRET || !BROADCASTER_ID || !WEBHOOK_SECRET) {
  console.error('Variables manquantes dans .env :')
  console.error('  TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BROADCASTER_ID, WEBHOOK_SECRET')
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

async function registerEventSub(token) {
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      type:    'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: BROADCASTER_ID },
      transport: {
        method:   'webhook',
        callback: CALLBACK_URL,
        secret:   WEBHOOK_SECRET
      }
    })
  })
  return res.json()
}

async function listEventSub(token) {
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    headers: {
      'Client-Id':     CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  })
  return res.json()
}

;(async () => {
  try {
    console.log('Obtention du token app...')
    const token = await getAppToken()

    console.log('Enregistrement EventSub...')
    const result = await registerEventSub(token)
    console.log(JSON.stringify(result, null, 2))

    if (result.data?.[0]?.status === 'webhook_callback_verification_pending') {
      console.log('\nSubscription enregistrée. Twitch va vérifier le webhook dans quelques secondes.')
      console.log('Vérifie les logs Render pour voir la confirmation.')
    } else if (result.error) {
      console.error('\nErreur:', result.message)
      if (result.status === 409) {
        console.log('Subscription déjà existante. Subscriptions actives :')
        const list = await listEventSub(token)
        list.data?.forEach(s => console.log(`  ${s.type} → ${s.transport.callback} [${s.status}]`))
      }
    }
  } catch (e) {
    console.error(e)
  }
})()
