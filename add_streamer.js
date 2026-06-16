// Ajoute un streamer à Karto : récupère l'ID de sa récompense et enregistre le webhook.
// Usage : node add_streamer.js <twitch_login>

require('dotenv').config()
const http     = require('http')
const readline = require('readline')

const CLIENT_ID      = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET
const CALLBACK_URL   = process.env.CALLBACK_URL || 'https://karto-182e.onrender.com/webhook'

const login = process.argv[2]
if (!login) { console.error('Usage : node add_streamer.js <twitch_login>'); process.exit(1) }

function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()) }))
}

async function getAppToken() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' })
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(JSON.stringify(data))
  return data.access_token
}

async function getBroadcasterId(appToken, twitchLogin) {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${twitchLogin}`, {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${appToken}` }
  })
  const data = await res.json()
  return data.data?.[0]
}

function getUserToken() {
  return new Promise((resolve, reject) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent('http://localhost:3000')}&response_type=code&scope=channel%3Aread%3Aredemptions`
    console.log('\nOuvre ce lien dans ton navigateur (connecte-toi avec le compte Twitch du streamer) :\n')
    console.log(authUrl + '\n')
    const { exec } = require('child_process')
    exec(`start "" "${authUrl}"`)

    const server = http.createServer(async (req, res) => {
      const url  = new URL(req.url, 'http://localhost:3000')
      const code = url.searchParams.get('code')
      if (!code) { res.end('Pas de code.'); return }
      res.end('<h2>Autorisé ! Tu peux fermer cet onglet.</h2>')
      server.close()

      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          code, grant_type: 'authorization_code',
          redirect_uri: 'http://localhost:3000'
        })
      })
      const data = await tokenRes.json()
      if (!data.access_token) { reject(new Error(JSON.stringify(data))); return }
      resolve(data.access_token)
    })
    server.listen(3000)
  })
}

async function listRewards(userToken, broadcasterId) {
  const res = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${userToken}` }
  })
  return (await res.json()).data || []
}

async function registerEventSub(appToken, broadcasterId, rewardId) {
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, reward_id: rewardId },
      transport: { method: 'webhook', callback: CALLBACK_URL, secret: WEBHOOK_SECRET }
    })
  })
  return res.json()
}

;(async () => {
  try {
    console.log(`\nAjout du streamer : ${login}`)

    console.log('Récupération de l\'ID Twitch...')
    const appToken    = await getAppToken()
    const broadcaster = await getBroadcasterId(appToken, login)
    if (!broadcaster) { console.error(`Compte Twitch "${login}" introuvable.`); process.exit(1) }
    console.log(`✓ ${broadcaster.display_name} (ID: ${broadcaster.id})`)

    console.log('\nEn attente de l\'autorisation Twitch...')
    const userToken = await getUserToken()
    console.log('✓ Autorisation reçue.')

    console.log('\nRécupération des récompenses...')
    const rewards = await listRewards(userToken, broadcaster.id)

    if (rewards.length === 0) {
      console.error('Aucune récompense trouvée. Crée d\'abord la récompense sur ton dashboard Twitch.')
      process.exit(1)
    }

    console.log('\nRécompenses disponibles :')
    rewards.forEach((r, i) => console.log(`  [${i + 1}] "${r.title}" — ${r.cost} pts`))

    const choix = await question('\nQuelle récompense correspond au booster Karto ? (numéro) : ')
    const reward = rewards[parseInt(choix) - 1]
    if (!reward) { console.error('Choix invalide.'); process.exit(1) }

    console.log(`\n✓ Récompense sélectionnée : "${reward.title}" (${reward.id})`)

    // Le token utilisateur n'est plus nécessaire après cette étape
    console.log('\nEnregistrement du webhook EventSub...')
    const result = await registerEventSub(appToken, broadcaster.id, reward.id)

    if (result.data?.[0]?.status === 'webhook_callback_verification_pending') {
      console.log('✓ Webhook enregistré. Twitch va le vérifier dans quelques secondes.')
      console.log('\n--- INFOS À AJOUTER DANS streamers/ ---')
      console.log(`Dossier       : streamers/${login}/`)
      console.log(`twitch_login  : ${broadcaster.login}`)
      console.log(`broadcaster_id: ${broadcaster.id}`)
      console.log(`reward_id     : ${reward.id}`)
      console.log('----------------------------------------')
    } else if (result.status === 409) {
      console.log('Webhook déjà enregistré pour cette récompense.')
    } else {
      console.error('Erreur:', JSON.stringify(result, null, 2))
    }
  } catch(e) {
    console.error(e)
  }
})()
