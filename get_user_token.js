// Script OAuth one-shot pour obtenir un token utilisateur Twitch
// Usage : node get_user_token.js
// Ouvre le navigateur, tu te connectes, le token est sauvegardé dans .env

require('dotenv').config()
const http = require('http')
const https = require('https')

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET
const REDIRECT_URI  = 'http://localhost:3000'
const SCOPES        = 'channel:read:redemptions channel:manage:redemptions'

const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}`

console.log('\nOuvre ce lien dans ton navigateur :\n')
console.log(authUrl)
console.log('\nEn attente de la redirection...\n')

// Ouvre automatiquement le navigateur (Windows)
const { exec } = require('child_process')
exec(`start "" "${authUrl}"`)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000')
  const code = url.searchParams.get('code')

  if (!code) {
    res.end('Pas de code reçu.')
    return
  }

  res.end('<h2>Autorisation reçue ! Tu peux fermer cet onglet.</h2>')
  server.close()

  // Échange le code contre un token
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI
  })

  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  const data = await tokenRes.json()

  if (!data.access_token) {
    console.error('Erreur:', JSON.stringify(data))
    process.exit(1)
  }

  console.log('Token obtenu !')

  // Mise à jour automatique du .env
  const fs = require('fs')
  let env = fs.readFileSync('.env', 'utf8')
  const updates = {
    TWITCH_USER_TOKEN:    data.access_token,
    TWITCH_REFRESH_TOKEN: data.refresh_token
  }
  for (const [key, val] of Object.entries(updates)) {
    if (env.includes(`${key}=`)) {
      env = env.replace(new RegExp(`${key}=.*`), `${key}=${val}`)
    } else {
      env += `\n${key}=${val}`
    }
  }
  fs.writeFileSync('.env', env)
  console.log('.env mis à jour (access token + refresh token).')
  console.log('\nN\'oublie pas de mettre à jour TWITCH_USER_TOKEN et TWITCH_REFRESH_TOKEN sur Render.')
  console.log('\nLance maintenant : node register_eventsub.js')
})

server.listen(3000)
