#!/usr/local/bin/node --no-warnings

const { homedir } = require('os')
const fs = require('fs')
const { unlinkSync } = fs
const { writeFile } = fs.promises
const { createServer } = require('http')
const { request } = require('https')
const { spawn } = require('child_process')
const { join } = require('path')
const confPath = join(homedir(), '.spotify-code.json')
const conf = (() => {
  try { return require(confPath) }
  catch (err) { return {} }
})()

const fromEntries = iter =>
  Object.assign(...[...iter].map(([ k, v ]) => ({ [k]: v })))

const updateConf = newConf =>
  writeFile(confPath, JSON.stringify({ ...conf, ...newConf }, null, 2))

const knownErrors = {
  NO_ACTIVE_DEVICE: 'No active devices found, you need to open spotify or restart it.',
  NO_NEXT_TRACK: 'No next track found',
  NO_PREV_TRACK: 'No previous track found',
  RATE_LIMITED: 'The user is rate limited due to too frequent track play, also known as cat-on-the-keyboard spamming.',
  PREMIUM_REQUIRED: 'Spotify premium is required for this',
}

const haltAndCatchFire = err => {
  console.error(knownErrors[err.reason] || err)
  process.exit(1)
}

const port = 7584
const client_id = conf.id
const client_secret = conf.secret
const redirect_uri = `http://localhost:${port}`
const param = String(process.argv[2])
const tryJSON = data => { try { return JSON.parse(data) } catch (err) { return data } }
const getBody = async stream => {
  const data = []

  for await (const chunk of stream) {
    data.push(chunk.toString('utf8'))
  }

  return tryJSON(data.join(''))
}

const appToken = `Basic ${new Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`
const accountURL = 'https://accounts.spotify.com/api'
const playerURL = 'https://api.spotify.com/v1/me/player'
const contentType = 'application/x-www-form-urlencoded'
const spotify = (method, url, { token, body }) => new Promise((resolve, reject) => {
  const headers = { Authorization: token, 'content-type': contentType }
  request(url, { method, headers }, async response => {
    if (response.statusCode !== 200) {
      if (response.statusCode === 204) return resolve(null)
      return reject(Object.assign(Error(response.statusMessage), {
        url,
        method,
        headers,
        code: response.statusCode,
        requestBody: body,
        ...(await getBody(response)).error
      }))
    }

    try { resolve(getBody(response)) }
    catch (err) { reject(err) }
  }).on('error', reject)
    .end(body && new URLSearchParams(body).toString())
})

spotify.post = (path, options) => spotify('POST', path, options)
spotify.put = (path, options) => spotify('PUT', path, options)
spotify.get = (path, { body, token } = {}) => spotify(
  'GET',
  body ? `${path}?${new URLSearchParams(body)}` : path,
  { token },
)

const actions = {
  play: token => spotify.put(`${playerURL}/play`, { token }),
  next: token => spotify.post(`${playerURL}/next`, { token }),
  pause: token => spotify.put(`${playerURL}/pause`, { token }),
  previous: token => spotify.post(`${playerURL}/previous`, { token }),
  default: async token => {
    const pl = await spotify.get(`${playerURL}/currently-playing`, { token })
    const nextState = pl && pl.is_playing ? 'pause' : 'play'
    await spotify.put(`${playerURL}/${nextState}`, { token })
  }
}

const execParam = token => (actions[param] || actions.default)(`Bearer ${token}`)

const similarSpelling = fromEntries(Object.entries({
  logout: [ 'sign-out', 'signout' ],
  previous: [ 'previou', 'pervious', 'prev', 'precedent' ],
}).flatMap(([ param, alts ]) => alts.map(alt => [ alt, param ])))

const expiredAt = conf.timestamp + conf.expires_in * 1000

const template = text => `
  <div style="font-family:mono;font-size:30;text-align:center;padding-top:5em">
    ${text}
    <br>
    You can close this tab now
  </div>
`

if (!conf.id || !conf.secret) {
  console.error(`Incomplete crendentials:

  You need to configure a spotify app for this, read more here:
    -> https://developer.spotify.com/documentation/general/guides/app-settings/#register-your-app

  If you already have an application setup find your crendentials here:
    -> https://developer.spotify.com/dashboard/applications

  Then edit them here: ${confPath}`)

  updateConf({ id: '', secret: '' })
    .then(() => process.exit(1))
    .catch(haltAndCatchFire)
}

if (similarSpelling[param]) {
  console.error(`Unknown param <${param}>, did you mean <${similarSpelling[param]}> ?`)
  process.exit(1)
}

if (param === 'logout') {
  unlinkSync(confPath)
  console.log('config file', confPath, 'removed')
} else if (expiredAt < Date.now()) {
  const now = Date.now()
  spotify.post(`${accountURL}/token`, {
    body: { grant_type: 'refresh_token', refresh_token: conf.refresh_token },
    token: appToken,
  }).then(async response => Promise.all([
    execParam(response.access_token),
    updateConf({ timestamp: now, ...response }),
  ])).catch(haltAndCatchFire)
} else if (conf.access_token) {
  execParam(conf.access_token).catch(haltAndCatchFire)
} else {
  const initialState = Math.random()
    .toString(36)
    .slice(2)

  const url = `https://accounts.spotify.com/authorize?${
    new URLSearchParams({
      client_id,
      redirect_uri,
      state: initialState,
      response_type: 'code',
      scope: 'user-modify-playback-state user-read-playback-state',
    })}`

  const openCmd = process.platform === 'linux' ? 'xdg-open' : 'open'
  const open = spawn(openCmd, [url], { stdio: 'ignore', detached: true })
  open.on('error', err =>
    console.log(`Allow the use of your spotify account by opening ${url}`))

  createServer(async (req, res) => {
    try {
      const url = new URL(`http://localhost:${port}/${req.url}`)
      const { code, state } = fromEntries(url.searchParams)

      if (!code) throw Error('No code')
      if (state !== initialState) throw Error('State mismatch')

      const now = Date.now()
      const body = { code, redirect_uri, grant_type: 'authorization_code' }
      const response = await spotify
        .post(`${accountURL}/token`, { body, token: appToken })

      res.end(template('All Good !'))

      await Promise.all([
        execParam(response.access_token),
        updateConf({ ...conf, timestamp: now, ...response }),
      ]).catch(haltAndCatchFire)

      process.exit(0)
    } catch (err) {
      res.status = err.status || 500
      res.end(template(err.reason || err.statusMessage || err.message))
      setTimeout(haltAndCatchFire, 1000, err)
    }

  }).listen(port, err => {
    err && haltAndCatchFire(err)
    console.log(`waiting for authorization...`)
  }).on('error', haltAndCatchFire)
}
