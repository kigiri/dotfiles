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

// Object.fromEntries: [['a', 1], ['b', 2]] => { a: 1, b: 2 }
const fromEntries = iter =>
  Object.assign(...[...iter].map(([ k, v ]) => ({ [k]: v })))

const updateConf = newConf =>
  writeFile(confPath, JSON.stringify({ ...conf, ...newConf }, null, 2))

const knownErrors = {
  RATE_LIMITED: 'The user is rate limited due to too frequent track play, also known as cat-on-the-keyboard spamming.',
  NO_NEXT_TRACK: 'No next track found',
  NO_PREV_TRACK: 'No previous track found',
  NO_ACTIVE_DEVICE: 'No active devices found, you need to open spotify or restart it.',
  PREMIUM_REQUIRED: 'Spotify premium is required for this',
}

const haltAndCatchFire = err => {
  console.error(knownErrors[err.reason] || err)
  process.exit(1)
}

const port = conf.port || 7584
const redirect_uri = `http://localhost:${port}`
const param = String(process.argv[2])
const getBody = async stream => {
  const data = []

  for await (const chunk of stream) {
    data.push(chunk.toString('utf8'))
  }

  try {
    return JSON.parse(data.join(''))
  } catch (err) {
    return data
  }
}

const toBase64 = str => Buffer.from(str).toString('base64')
const appToken = `Basic ${toBase64(`${conf.id}:${conf.secret}`)}`
const playerURL = 'https://api.spotify.com/v1/me/player'
const accountURL = 'https://accounts.spotify.com'
const contentType = 'application/x-www-form-urlencoded'

const spotify = (method, url, { token, body }) => new Promise((resolve, reject) => {
  const headers = { Authorization: token, 'content-type': contentType }
  request(url, { method, headers }, async response => {
    if (response.statusCode === 200) return resolve(getBody(response))
    if (response.statusCode === 204) return resolve(null)

    reject(Object.assign(Error(response.statusMessage), {
      url,
      method,
      headers,
      code: response.statusCode,
      requestBody: body,
      ...(await getBody(response)).error
    }))
  }).on('error', reject)
    .end(body && new URLSearchParams(body).toString())
})

const player = {
  play: token => spotify('PUT', `${playerURL}/play`, { token }),
  next: token => spotify('POST', `${playerURL}/next`, { token }),
  pause: token => spotify('PUT', `${playerURL}/pause`, { token }),
  previous: token => spotify('POST', `${playerURL}/previous`, { token }),
  toggle: async token => {
    const pl = await spotify('GET', `${playerURL}/currently-playing`, { token })
    const nextState = pl && pl.is_playing ? 'pause' : 'play'
    return spotify('PUT', `${playerURL}/${nextState}`, { token })
  }
}

const executeSpotifyCommand = token =>
  (player[param.toLowerCase()] || player.toggle)(`Bearer ${token}`)

const template = text => `
  <div style="font-family:mono;font-size:30;text-align:center;padding-top:5em">
    ${text}
    <br>
    You can close this tab now
  </div>
`

const similarSpelling = fromEntries(Object.entries({
  logout: [ 'sign-out', 'signout' ],
  previous: [ 'previou', 'pervious', 'prev', 'precedent' ],
}).flatMap(([ param, alts ]) => alts.map(alt => [ alt, param ])))

if (similarSpelling[param]) {
  console.error(`Unknown param <${param}>, did you mean <${similarSpelling[param]}> ?`)
  process.exit(1)
}

const expiredAt = conf.timestamp + conf.expires_in * 1000

if (!conf.id || !conf.secret) {
  console.error(`Incomplete crendentials:

  You need to configure a spotify app for this, read more here:
    -> https://developer.spotify.com/documentation/general/guides/app-settings/#register-your-app

  If you already have an application setup find your crendentials here:
    -> https://developer.spotify.com/dashboard/applications

  Then edit them here: ${confPath}`)

  updateConf({ id: '', secret: '', port, ...conf })
    .then(() => process.exit(1), haltAndCatchFire)

} else if (param === 'logout') {

  unlinkSync(confPath)
  console.log('config file', confPath, 'removed')

} else if (expiredAt < Date.now()) {

  const timestamp = Date.now()
  spotify('POST', `${accountURL}/api/token`, {
    body: { grant_type: 'refresh_token', refresh_token: conf.refresh_token },
    token: appToken,
  }).then(response => Promise.all([
    executeSpotifyCommand(response.access_token),
    updateConf({ timestamp, ...response }),
  ])).catch(haltAndCatchFire)

} else if (conf.access_token) {

  executeSpotifyCommand(conf.access_token)
    .catch(haltAndCatchFire)

} else {

  const initialState = Math.random()
    .toString(36)
    .slice(2)

  const url = `${accountURL}/authorize?${
    new URLSearchParams({
      redirect_uri,
      state: initialState,
      client_id: conf.id,
      response_type: 'code',
      scope: 'user-modify-playback-state user-read-playback-state',
    })}`

  const openCmd = process.platform === 'linux' ? 'xdg-open' : 'open'
  spawn(openCmd, [url], { stdio: 'ignore', detached: true })
    .on('error', err =>
      console.log(`Allow the use of your spotify account by opening ${url}`))

  createServer(async (req, res) => {
    try {
      const url = new URL(`http://localhost:${port}/${req.url}`)
      const { code, state } = fromEntries(url.searchParams)

      if (!code) throw Error('No code')
      if (state !== initialState) throw Error('State mismatch')

      const timestamp = Date.now()
      const body = { code, redirect_uri, grant_type: 'authorization_code' }
      const response =
        await spotify('POST', `${accountURL}/api/token`, { body, token: appToken })

      res.end(template('All Good !'))

      await Promise.all([
        executeSpotifyCommand(response.access_token),
        updateConf({ timestamp, ...response }),
      ]).catch(haltAndCatchFire)

      process.exit(0)
    } catch (err) {
      res.status = err.statusCode || err.code || 500
      res.end(template(err.reason || err.statusMessage || err.message))
      setTimeout(haltAndCatchFire, 1000, err)
    }

  }).listen(port, err => {
    err && haltAndCatchFire(err)
    console.log(`waiting for authorization...`)
  }).on('error', haltAndCatchFire)
}
