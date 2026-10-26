'use strict'
/*
 * Schematic Builder Bot (Mineflayer, Java Edition)
 *
 * In-game chat commands (type in normal chat):
 *   !list                         list schematics in ./schematics
 *   !build <file> [x y z]         build at x y z (default: where you are standing)
 *   !stop                         stop the current build
 *   !status                       show progress
 *
 * Modes (MC_MODE):
 *   commands (default)  bot must be OP. Uses /fill and /setblock. Fast, exact
 *                       block states (stairs facing, slabs, doors, etc).
 *   place               bot must be in creative mode. Walks around and places
 *                       blocks by hand. Does not set rotation/state, and blocks
 *                       need a neighbouring solid block to attach to.
 */

const fs = require('fs/promises')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')

const config = {
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USER || 'BuilderBot',
  auth: process.env.MC_AUTH || 'offline', // 'microsoft' for online-mode servers
  version: process.env.MC_VERSION || false, // false = auto-detect
  owner: process.env.MC_OWNER || null, // only this player can command the bot
  mode: process.env.MC_MODE || 'commands', // 'commands' | 'place'
  delayMs: Number(process.env.MC_DELAY || 60), // delay between commands
  schematicDir: process.env.MC_SCHEM_DIR || path.join(__dirname, 'schematics')
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  auth: config.auth,
  version: config.version
})
bot.loadPlugin(pathfinder)

let job = null // { name, total, done, stop, lastPct }

function say (msg) {
  console.log(`[bot] ${msg}`)
  bot.chat(msg)
}

// ---------------------------------------------------------------- loading

function stateString (block) {
  const props = typeof block.getProperties === 'function' ? block.getProperties() : {}
  const kv = Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',')
  return `minecraft:${block.name}${kv ? `[${kv}]` : ''}`
}

async function resolveFile (name) {
  const base = path.basename(name) // no path traversal
  const candidates = path.extname(base) ? [base] : [base + '.schem', base + '.schematic']
  for (const c of candidates) {
    const full = path.join(config.schematicDir, c)
    try {
      await fs.access(full)
      return full
    } catch {}
  }
  throw new Error(`Schematic not found: ${base}`)
}

async function loadBlocks (name) {
  const file = await resolveFile(name)
  const schem = await Schematic.read(await fs.readFile(file), bot.version)
  const { x: sx, y: sy, z: sz } = schem.size
  const start = schem.start()
  const blocks = []
  // bottom-up, so supports get placed before things that attach to them
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const b = schem.getBlock(start.offset(x, y, z))
        if (!b || AIR.has(b.name)) continue
        blocks.push({ x, y, z, name: b.name, state: stateString(b) })
      }
    }
  }
  return { blocks, size: schem.size }
}

// ---------------------------------------------------------------- progress

function tick (n = 1) {
  job.done += n
  const pct = Math.floor((job.done / job.total) * 100)
  if (pct >= job.lastPct + 10) {
    job.lastPct = pct - (pct % 10)
    say(`${job.name}: ${pct}% (${job.done}/${job.total})`)
  }
}

// ---------------------------------------------------------------- commands mode

async function buildCommands (blocks, origin) {
  // merge neighbouring identical blocks along X into /fill runs
  const runs = []
  let cur = null
  for (const b of blocks) {
    if (cur && cur.state === b.state && cur.y === b.y && cur.z === b.z && b.x === cur.x2 + 1) {
      cur.x2 = b.x
      cur.count++
    } else {
      cur = { x1: b.x, x2: b.x, y: b.y, z: b.z, state: b.state, count: 1 }
      runs.push(cur)
    }
  }

  for (const r of runs) {
    if (job.stop) return
    const y = origin.y + r.y
    const z = origin.z + r.z
    const x1 = origin.x + r.x1
    const x2 = origin.x + r.x2
    bot.chat(r.count === 1
      ? `/setblock ${x1} ${y} ${z} ${r.state}`
      : `/fill ${x1} ${y} ${z} ${x2} ${y} ${z} ${r.state}`)
    tick(r.count)
    await sleep(config.delayMs)
  }
}

// ---------------------------------------------------------------- place mode

const FACES = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
]

async function buildPlace (blocks, origin) {
  if (bot.game.gameMode !== 'creative') {
    throw new Error(`Place mode needs creative. Run: /gamemode creative ${bot.username}`)
  }
  const Item = require('prismarine-item')(bot.registry)
  bot.pathfinder.setMovements(new Movements(bot))

  const skipped = {}
  for (const b of blocks) {
    if (job.stop) return
    const target = origin.offset(b.x, b.y, b.z)

    const existing = bot.blockAt(target)
    if (existing && existing.name === b.name) { tick(); continue }

    const item = bot.registry.itemsByName[b.name]
    if (!item) { skipped[b.name] = (skipped[b.name] || 0) + 1; tick(); continue }

    try {
      await bot.creative.setInventorySlot(36, new Item(item.id, 64))
      await bot.equip(item.id, 'hand')
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 4))

      // find a solid neighbour to click against
      let placed = false
      for (const face of FACES) {
        const ref = bot.blockAt(target.plus(face))
        if (ref && ref.boundingBox === 'block') {
          await bot.placeBlock(ref, face.scaled(-1))
          placed = true
          break
        }
      }
      if (!placed) skipped['(no support)'] = (skipped['(no support)'] || 0) + 1
    } catch (err) {
      skipped['(error)'] = (skipped['(error)'] || 0) + 1
      console.warn(`[bot] failed at ${target}: ${err.message}`)
    }
    tick()
  }

  const total = Object.values(skipped).reduce((a, n) => a + n, 0)
  if (total) console.log('[bot] skipped:', skipped)
  if (total) say(`Skipped ${total} blocks (see console for details).`)
}

// ---------------------------------------------------------------- runner

async function startBuild (file, origin) {
  if (job) throw new Error('Already building. Use !stop first.')
  const { blocks, size } = await loadBlocks(file)
  if (!blocks.length) throw new Error('Schematic has no blocks.')

  job = { name: file, total: blocks.length, done: 0, stop: false, lastPct: 0 }
  say(`Building ${file} (${size.x}x${size.y}x${size.z}, ${blocks.length} blocks) at ${origin.x} ${origin.y} ${origin.z} [${config.mode}]`)

  try {
    if (config.mode === 'place') await buildPlace(blocks, origin)
    else await buildCommands(blocks, origin)
  } finally {
    const stopped = job.stop
    job = null
    say(stopped ? 'Build stopped.' : 'Build finished.')
  }
}

// ---------------------------------------------------------------- chat interface

bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  if (config.owner && username !== config.owner) return
  if (!message.startsWith('!')) return

  const [cmd, ...args] = message.trim().split(/\s+/)
  try {
    if (cmd === '!list') {
      const files = (await fs.readdir(config.schematicDir))
        .filter((f) => /\.(schem|schematic)$/.test(f))
      say(files.length ? files.join(', ') : 'No schematics found.')
    } else if (cmd === '!build') {
      const [file, ...coords] = args
      if (!file) return say('Usage: !build <file> [x y z]')
      let origin
      if (coords.length === 3 && coords.every((c) => /^-?\d+$/.test(c))) {
        origin = new Vec3(...coords.map(Number))
      } else {
        const p = bot.players[username]
        if (!p || !p.entity) return say('I can\'t see you. Give coordinates: !build <file> x y z')
        origin = p.entity.position.floored()
      }
      await startBuild(file, origin)
    } else if (cmd === '!stop') {
      if (job) job.stop = true
      else say('Nothing to stop.')
    } else if (cmd === '!status') {
      say(job ? `${job.name}: ${job.done}/${job.total}` : 'Idle.')
    }
  } catch (err) {
    console.error(err)
    say(`Error: ${err.message}`)
  }
})

bot.once('spawn', () => {
  console.log(`[bot] spawned. mode=${config.mode}, schematics in ${config.schematicDir}`)
  if (!config.owner) {
    console.warn('[bot] MC_OWNER is not set: anyone in chat can command the bot.')
  }
})
bot.on('kicked', (reason) => console.log('[bot] kicked:', reason))
bot.on('error', (err) => console.error('[bot] error:', err.message))
