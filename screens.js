#!/usr/local/bin/node
(async () => { // ghetto top level await

// imports
const child_process = require('child_process')
const fs = require('fs')
const { join } = require('path')

// utils
const promisify = fn => (...a)=>new Promise((s,f)=>fn(...a,(e,v)=>e?f(e):s(v)))
const fromEntries = i => Object.assign(...[...i].map(([k,v])=>({[k]:v})))
const split = s => String(s).trim().split('\n')
const exec = promisify(child_process.exec)
const confPath = join(process.env.HOME, '.saved-outputs-positions.json')
const config = (() => { // IIFE cause we ain't got do expression yet :(
  try { return require(confPath) }
  catch (err) { return {} } // ignore error and return an object
})()


//sys/devices/pci0000:00/0000:00:02.0/drm/card0/card0-HDMI-A-1/edid -> HDMI-1
const getOutputName = edidPath => edidPath
  .split('/')
  .slice(-2, -1)[0]
  .split(/[a-z0-9]+-([a-z]+).+([0-9])/i)
  .filter(Boolean)
  .join('-')

const getEdidId = edid => [
  // first part is base64 encoded bytes containing vendor, serial and other
  // see https://en.wikipedia.org/wiki/Extended_Display_Identification_Data
  edid
    .slice(8, 18)
    .toString('base64')
    .slice(0, -2),

  // the second part are the descriptive blocks, just so that the name appear
  edid
    .slice(54, 126)
    .toString('ascii')
    .replace(/[^a-z0-9]/gi, ''),
].join('')

const [ i3workspacesJSON, xrandrQuery, edidsEntries ] = (await Promise.all([
  exec('i3-msg -t get_workspaces'),
  exec('xrandr --query').then(split),
  exec('find /sys/devices -name edid')
    .then(edidList => Promise.all(split(edidList)
      .map(async edidPath => [
        getOutputName(edidPath),
        getEdidId(await exec(`cat ${edidPath}`, { encoding: 'buffer' })),
      ]))),
]))

const edids = fromEntries(edidsEntries)
const i3workspaces = JSON.parse(i3workspacesJSON)
const outputsValues = xrandrQuery.slice(1).flatMap((line, i, lines) => {
  if (line.startsWith('  ')) return []
  // line: DP-2 connected 3440x1440+1920+0 (...) 800mm x 335mm

  const [name, status, ...rest] = line.trim()
    .split(/([^(]+)/)[1].trim() // DP-2 connected 3440x1440+1920+0
    .split(/\s+/)               // [ 'DP-2', 'connected', '3440x1440+1920+0' ]

  const screen = {
    id: edids[name] || config[name] || '',
    name,
    status,
    connected: status === 'connected',
    workspaces: i3workspaces
      .filter(workspace => workspace.output === name)
      .map(workspace => workspace.name)
  }

  if (rest[0] === 'primary') {
    screen.primary = true
    rest.shift() // shifting to allow the rest[0] to be resolution
  }

  // parse resolution
  if (rest[0]) {
    // '3440x1440+1920+0' -> [ 3440, 1440, 1920, 0 ]
    const [ width, height, left, top ] = rest[0].split(/[^0-9]/).map(Number)
    Object.assign(screen, { width, height, left, top, active: true })
    rest[1] && (screen.rotate = rest[1])
  } else if (screen.connected) {
    // if the screen is connected but inactive, we get his max resolution
    // from the next line

    const [width, height] = (lines[i + 1] || '')
      .trim()        // '3440x1440     59.94*+  29.97'
      .split(' ')[0] // '3440x1440'
      .split('x')    // [ '3440', '1440' ]
      .map(Number)   // [ 3440, 1440 ]

    Object.assign(screen, { width, height })
  }

  if (screen.connected && !screen.active) {
    // if the screen is connected but not active yet
    // we try to retrieve previously stored i3 workspaces

    const { workspaces } = (config[screen.id] || {})
    workspaces && (screen.workspaces = workspaces)

    screen.plugged = true
  } else if (!screen.connected && screen.active) {
    screen.unplugged = true
  }

  return screen
})

const outputs = fromEntries(outputsValues
  .map(screen => [ screen.name, screen ]))

// remove moved workspace from previous screens
for (const screen of outputsValues.filter(s => s.plugged)) {
  for (const name of screen.workspaces) {
    const workspace = i3workspaces.find(w => w.name === name)
    if (!workspace) continue
    outputs[workspace.output].workspaces = outputs[workspace.output]
      .workspaces.filter(n => n !== name)
  }
}

// generate xrandr args from screen properties
const genArgs = screen => [
  screen.primary && '--primary',
  screen.rotate && `--rotate ${screen.rotate}`,
  (screen.width || screen.height) && `--mode ${screen.width}x${screen.height}`,
  (screen.top || screen.left) && `--pos ${screen.left}x${screen.top}`,
].filter(Boolean).join(' ')


const newScreensPlugged = outputsValues.some(screen => screen.plugged)
const newScreensUnplugged = outputsValues.some(screen => screen.unplugged)
const setupHasChanged = newScreensUnplugged || newScreensPlugged
const shouldSave = !setupHasChanged || (process.argv[2] || '').includes('save')
const newConfig = {

  // apply previous configs
  ...config,

  // save current screen -> outputs links
  ...fromEntries(outputsValues
      .filter(screen => screen.id)
      .map(screen => [screen.name, screen.id])),

  // update workspace and xrandr args
  ...fromEntries(outputsValues
    .filter(screen => screen.id)
    .map(screen => (shouldSave || screen.unplugged)
      ? [screen.id, { workspaces: screen.workspaces, args: genArgs(screen) }]
      : [screen.id, { workspaces: screen.workspaces, ...config[screen.id] }])),
}

const xrandrArgs = () => outputsValues
  .map(screen => screen.connected
    ? `--output ${screen.name} ${config[screen.id] ? genArgs(screen) : config[screen.id].args}`
    : `--output ${screen.name} --off`)

// generate i3 msg sequence
const generateMsgs = () => [
  ...outputsValues
    .filter(screen => screen.workspaces.length)
    .flatMap(screen => screen.workspaces
      .flatMap(n => [

        // require 2 steps, focus workspace -> move to output
        `workspace ${n}`,
        `move workspace to output ${screen.name}`,
      ])),

  // restore focus
  `workspace ${i3workspaces.find(w => w.focused).name}`,
]

console.log(xrandrArgs())

await Promise.all([

  // update config file
  fs.promises.writeFile(confPath, JSON.stringify(newConfig, null, 2)),

  // apply xrandr
  setupHasChanged && exec([ 'xrandr', ...xrandrArgs() ].join(' ')),

])

// move workspaces
await newScreensPlugged && exec(`i3-msg "${generateMsgs().join('; ')}"`)


console.log({
  outputs,
  newConfig,
  newScreensPlugged,
  newScreensUnplugged,
  setupHasChanged,
  shouldSave,
})

})()
  .catch(err => {
    console.error(err)
    process.exit(err.code || 1)
  })
