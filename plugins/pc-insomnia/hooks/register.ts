import type { EngineInterface, Register } from 'claude-code'

import { powershellArgv } from './windows'

// pc-insomnia: keeps the machine awake while Claude works, for a grace
// period after, or until a time you set with /insomnia. Optionally keeps a
// closed lid from putting the laptop to sleep (Windows and WSL; Linux through
// systemd-inhibit).
//
// The hold is a child process: while it lives the machine stays awake, and
// when it dies the OS takes the hold back by itself (kill, crash, unload).
// Only the lid setting on Windows outlives it, so that one is journaled and
// restored at the end, by the child itself if Claude Code dies, and swept at
// the next session start if both are gone.

type Prefs = { lid: boolean; display: boolean; graceMin: number }
type Platform = 'windows' | 'wsl' | 'macos' | 'linux' | 'unsupported'
type Stream = ReturnType<EngineInterface['process']['spawn']>
type Child = {
  stream: Stream
  lid: boolean
  display: boolean
  /** The Windows PID of the PowerShell holder, once it said it. */
  winPid?: number
  lidState: 'off' | 'pending' | 'on' | 'error'
  lidError?: string
  awake: boolean
  /** Set by stopChild: the reader leaves its loop at the next line, which kills the child. */
  stopping: boolean
}

const DEFAULTS: Prefs = { lid: false, display: false, graceMin: 5 }
const PREFS_KEY = 'prefs'
const MAX_HOURS = 12

let platform: Platform = 'unsupported'
let platformNote = ''
let prefs: Prefs = DEFAULTS
let claudePid = 0

let child: Child | null = null
let lastError: string | undefined
let working = false
let graceUntil: number | undefined
let graceTimer: { cancel: () => void } | undefined
let manualUntil: number | undefined
let manualTimer: { cancel: () => void } | undefined
let ticker: { cancel: () => void } | undefined
let queue: Promise<void> = Promise.resolve()

/** Runs `fn` after every change queued before it, so start/stop never overlap. */
function serial(fn: () => Promise<void>): Promise<void> {
  queue = queue.then(fn, fn).catch(err => {
    lastError = message(err)
  })
  return queue
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const info = await $.session.info()
    claudePid = Number((await $.process.hookEnv()).CLAUDE_PID ?? 0) || 0
    platform = pickPlatform(info.platform, info.isHosted === true)
    prefs = normalize(await $.store.get(PREFS_KEY))

    await $.command.register({
      name: 'insomnia',
      description: 'Garder le PC éveillé : /insomnia [2h | 45m | off | lid on|off | screen on|off | grace <min> | status]',
    })

    // A lid change left by a crash, a kill or a reboot is undone here.
    if (platform === 'windows' || platform === 'wsl') {
      void serial(async () => {
        const result = await runWindows($, { mode: 'sweep' })
        if (result === 'restored') $.ui.toast('pc-insomnia : réglage du capot restauré après un arrêt brutal.')
      })
    }

    refreshStatus($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      working = true
      graceTimer?.cancel()
      graceTimer = undefined
      graceUntil = undefined
      void reconcile($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      working = false
      const now = await $.clock.now()
      graceTimer?.cancel()
      if (prefs.graceMin > 0) {
        graceUntil = now + prefs.graceMin * 60_000
        graceTimer = $.clock.after(prefs.graceMin * 60_000, () => {
          graceUntil = undefined
          graceTimer = undefined
          void reconcile($)
        })
      } else {
        graceUntil = undefined
      }
      void reconcile($)
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      working = false
      graceTimer?.cancel()
      manualTimer?.cancel()
      graceUntil = manualUntil = undefined
      graceTimer = manualTimer = undefined
      await serial(() => stopChild($))
    }
    return next(e)
  })

  on('command.run', { command: 'insomnia' }, async ($, e) => {
    return { text: await runCommand($, e.args.trim().toLowerCase()) }
  })
}

// ---------------------------------------------------------------------------
// Commands

async function runCommand($: EngineInterface, args: string): Promise<string> {
  if (platform === 'unsupported') return `pc-insomnia ne fait rien ici : ${platformNote}`

  const [word = '', value = ''] = args.split(/\s+/)

  if (word === '' || word === 'status') return describe($)

  if (word === 'help' || word === 'aide') return HELP

  if (word === 'off' || word === 'stop') {
    manualTimer?.cancel()
    graceTimer?.cancel()
    manualUntil = graceUntil = undefined
    manualTimer = graceTimer = undefined
    await reconcile($)
    return working
      ? 'Minuteur annulé. Le maintien éveillé reste actif tant que Claude travaille.'
      : 'Maintien éveillé arrêté. La veille normale reprend.'
  }

  if (word === 'lid' || word === 'capot') {
    const on = parseSwitch(value)
    if (on === undefined) return 'Usage : /insomnia lid on|off'
    if (on && platform === 'macos') {
      return "Sur macOS, empêcher la veille capot fermé demande `sudo pmset -a disablesleep 1` : ce mod ne le fait pas. Utilisez l'app Insomnia pour ça."
    }
    await savePrefs($, { ...prefs, lid: on })
    await reconcile($, true)
    return on
      ? `Capot : le PC ne dormira pas capot fermé pendant le maintien éveillé.${WARNING}`
      : 'Capot : comportement normal (le réglage est restauré si le mod l’avait changé).'
  }

  if (word === 'screen' || word === 'ecran' || word === 'écran') {
    const on = parseSwitch(value)
    if (on === undefined) return 'Usage : /insomnia screen on|off'
    await savePrefs($, { ...prefs, display: on })
    await reconcile($, true)
    return on ? 'Écran : reste allumé pendant le maintien éveillé.' : 'Écran : peut s’éteindre normalement.'
  }

  if (word === 'grace' || word === 'délai' || word === 'delai') {
    const min = Number(value)
    if (!Number.isFinite(min) || min < 0 || min > 600) return 'Usage : /insomnia grace <minutes, 0 à 600>'
    await savePrefs($, { ...prefs, graceMin: Math.round(min) })
    return `Délai après la fin du travail de Claude : ${Math.round(min)} min.`
  }

  const ms = parseDuration(args)
  if (ms !== undefined) {
    if (ms <= 0 || ms > MAX_HOURS * 3_600_000) return `Durée entre 1 min et ${MAX_HOURS} h.`
    const now = await $.clock.now()
    manualTimer?.cancel()
    manualUntil = now + ms
    manualTimer = $.clock.after(ms, () => {
      manualUntil = undefined
      manualTimer = undefined
      void reconcile($)
    })
    await reconcile($)
    return `PC gardé éveillé jusqu'à ${clock(manualUntil)}${prefs.lid ? ', capot fermé compris' : ''}.`
  }

  return HELP
}

const WARNING =
  '\n⚠ Posez le PC sur une surface ventilée, pas dans un sac fermé : il continue de chauffer capot fermé.'

const HELP = [
  'pc-insomnia : garde le PC éveillé pendant que Claude travaille.',
  '  /insomnia               état actuel',
  '  /insomnia 2h | 45m | 1h30   éveillé jusqu’à une heure donnée, même sans Claude',
  '  /insomnia off           annule le minuteur et le délai',
  '  /insomnia lid on|off    ne pas dormir capot fermé (Windows, WSL, Linux)',
  '  /insomnia screen on|off garder aussi l’écran allumé',
  '  /insomnia grace <min>   délai après la fin d’une réponse (5 min par défaut)',
].join('\n')

async function describe($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const lines: string[] = []
  const held = child?.awake === true
  lines.push(held ? '👁 PC gardé éveillé.' : 'Veille normale (rien ne la bloque).')
  if (working) lines.push('• Claude travaille.')
  if (graceUntil !== undefined && graceUntil > now) lines.push(`• Délai après réponse : jusqu'à ${clock(graceUntil)}.`)
  if (manualUntil !== undefined && manualUntil > now) lines.push(`• Minuteur : jusqu'à ${clock(manualUntil)}.`)
  lines.push(`• Capot fermé : ${prefs.lid ? lidText() : 'veille normale'}.`)
  lines.push(`• Écran : ${prefs.display ? 'reste allumé' : 'peut s’éteindre'}. Délai : ${prefs.graceMin} min.`)
  lines.push(`• Système : ${platform}.`)
  if (lastError) lines.push(`⚠ Dernière erreur : ${lastError}`)
  return lines.join('\n')
}

function lidText(): string {
  if (!child) return 'pas de veille (actif pendant le maintien éveillé)'
  switch (child.lidState) {
    case 'on':
      return 'pas de veille (actif)'
    case 'pending':
      return 'en cours d’activation'
    case 'error':
      return `échec : ${child.lidError ?? 'inconnu'}`
    default:
      return 'veille normale'
  }
}

// ---------------------------------------------------------------------------
// The hold

/** Starts, stops or restarts the child to match what is wanted now. */
function reconcile($: EngineInterface, restart = false): Promise<void> {
  return serial(async () => {
    if (platform === 'unsupported') return
    const now = await $.clock.now()
    const want =
      working ||
      (graceUntil !== undefined && graceUntil > now) ||
      (manualUntil !== undefined && manualUntil > now)

    if (child && (!want || restart || child.lid !== prefs.lid || child.display !== prefs.display)) {
      await stopChild($)
    }
    if (want && !child) startChild($)
    refreshStatus($)
  })
}

function startChild($: EngineInterface): void {
  const argv = holdArgv()
  if (!argv) return
  lastError = undefined
  const stream = $.process.spawn({ argv })
  const me: Child = {
    stream,
    lid: prefs.lid,
    display: prefs.display,
    lidState: prefs.lid ? 'pending' : 'off',
    awake: false,
    stopping: false,
  }
  child = me

  void (async () => {
    let buffer = ''
    let stderr = ''
    try {
      for await (const { stream: which, text } of stream) {
        if (me.stopping) break
        if (which === 'stderr') {
          stderr = (stderr + text).slice(-500)
          continue
        }
        buffer += text
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          onLine($, me, line)
        }
      }
      if (me.stopping) return
      const end = await stream.result
      if (child === me && end.code !== 0) lastError = firstLine(stderr) || `le maintien s'est arrêté (code ${end.code})`
    } catch (err) {
      if (child === me) lastError = `impossible de lancer ${argv[0]} : ${message(err)}`
    } finally {
      if (child === me) {
        child = null
        refreshStatus($)
        if (lastError) $.ui.toast(`pc-insomnia : ${lastError}`)
      }
    }
  })()
}

function onLine($: EngineInterface, me: Child, line: string): void {
  if (line.startsWith('PID ')) {
    me.winPid = Number(line.slice(4)) || undefined
  } else if (line === 'LID on') {
    me.lidState = 'on'
  } else if (line.startsWith('LIDERR ')) {
    me.lidState = 'error'
    me.lidError = line.slice(7)
    $.ui.toast(`pc-insomnia : capot non modifié (${me.lidError}). Le PC reste éveillé capot ouvert.`)
  } else if (line === 'AWAKE') {
    me.awake = true
  } else if (line === 'TICK') {
    return
  } else if (line.startsWith('ERR ')) {
    lastError = line.slice(4)
  }
  if (child === me) refreshStatus($)
}

async function stopChild($: EngineInterface): Promise<void> {
  const me = child
  if (!me) return
  child = null
  me.stopping = true
  // Give the lid back before the kill: a killed PowerShell runs no `finally`.
  if (me.lid && me.winPid && (platform === 'windows' || platform === 'wsl')) {
    try {
      await runWindows($, { mode: 'release', holderPid: me.winPid })
    } catch (err) {
      lastError = `restauration du capot : ${message(err)}`
    }
  }
  // The reader leaves its loop at the child's next line (a TICK every 10 s
  // at most), which kills it; return() here kills it at once where the
  // stream allows a return while a read is pending.
  me.stream.return(undefined as never).catch(() => undefined)
  refreshStatus($)
}

function holdArgv(): string[] | undefined {
  switch (platform) {
    case 'windows':
    case 'wsl':
      return powershellArgv({
        mode: 'hold',
        lid: prefs.lid,
        display: prefs.display,
        // A Linux PID means nothing to Windows: under WSL the hold ends with
        // the kill, or after MAX_HOURS.
        watchPid: platform === 'windows' ? claudePid : 0,
        maxHours: MAX_HOURS,
      })
    case 'macos': {
      const flags = ['-i', ...(prefs.display ? ['-d'] : []), ...(claudePid ? ['-w', String(claudePid)] : ['-t', String(MAX_HOURS * 3600)])]
      return heartbeat(['caffeinate', ...flags])
    }
    case 'linux': {
      const what = ['idle', 'sleep', ...(prefs.lid ? ['handle-lid-switch'] : [])].join(':')
      // `tail --pid` ends with Claude Code, so the inhibitor never outlives it.
      const wait = claudePid ? ['tail', `--pid=${claudePid}`, '-f', '/dev/null'] : ['sleep', String(MAX_HOURS * 3600)]
      return heartbeat(['systemd-inhibit', `--what=${what}`, '--who=pc-insomnia', '--why=Claude Code travaille', '--mode=block', ...wait])
    }
    default:
      return undefined
  }
}

/**
 * Runs `cmd` in the background under sh, prints AWAKE, then TICK every 10 s
 * while it lives, and kills it when sh is told to stop.
 */
function heartbeat(cmd: string[]): string[] {
  const script = [
    '"$@" & c=$!',
    'trap \'kill $c 2>/dev/null; exit 0\' TERM INT HUP',
    'sleep 1; kill -0 $c 2>/dev/null || { wait $c; exit $?; }',
    'echo AWAKE',
    'while kill -0 $c 2>/dev/null; do sleep 10; echo TICK; done',
    'wait $c',
  ].join('\n')
  return ['/bin/sh', '-c', script, 'pc-insomnia', ...cmd]
}

/** Runs a one-shot Windows mode and answers its RESULT word. */
async function runWindows($: EngineInterface, p: { mode: 'release' | 'sweep'; holderPid?: number }): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(powershellArgv(p), { timeoutMs: 60_000 })
  const result = /^RESULT (\w+)/m.exec(stdout)?.[1]
  const err = /^ERR (.+)$/m.exec(stdout)?.[1]
  if (exitCode !== 0 || !result) throw new Error(err ?? (firstLine(stderr) || `powershell code ${exitCode}`))
  return result
}

// ---------------------------------------------------------------------------
// Status line

function refreshStatus($: EngineInterface): void {
  if (!child) {
    ticker?.cancel()
    ticker = undefined
    $.ui.status(lastError ? '👁 insomnia : erreur (/insomnia)' : undefined)
    return
  }
  if (!ticker) ticker = $.clock.every(30_000, () => void paintStatus($))
  void paintStatus($)
}

async function paintStatus($: EngineInterface): Promise<void> {
  if (!child) return
  const now = await $.clock.now()
  const parts = ['👁 éveillé']
  if (child.lid) parts.push(child.lidState === 'error' ? 'capot ⚠' : 'capot ok')
  if (child.display) parts.push('écran')
  const until = Math.max(manualUntil ?? 0, graceUntil ?? 0)
  if (working) parts.push('Claude travaille')
  else if (until > now) parts.push(`jusqu'à ${clock(until)}`)
  $.ui.status(parts.join(' · '))
}

// ---------------------------------------------------------------------------
// Helpers

function pickPlatform(p: string | undefined, hosted: boolean): Platform {
  if (hosted) {
    platformNote = 'la session tourne sur un serveur distant, pas sur votre machine.'
    return 'unsupported'
  }
  if (p === 'windows' || p === 'wsl' || p === 'macos' || p === 'linux') return p
  platformNote = `système non pris en charge (${p ?? 'inconnu'}).`
  return 'unsupported'
}

function normalize(raw: unknown): Prefs {
  const r = (raw ?? {}) as Partial<Prefs>
  return {
    lid: typeof r.lid === 'boolean' ? r.lid : DEFAULTS.lid,
    display: typeof r.display === 'boolean' ? r.display : DEFAULTS.display,
    graceMin:
      typeof r.graceMin === 'number' && Number.isFinite(r.graceMin) && r.graceMin >= 0 ? r.graceMin : DEFAULTS.graceMin,
  }
}

async function savePrefs($: EngineInterface, next: Prefs): Promise<void> {
  prefs = next
  await $.store.set(PREFS_KEY, next)
}

function parseSwitch(v: string): boolean | undefined {
  if (['on', 'oui', 'yes', '1', 'true'].includes(v)) return true
  if (['off', 'non', 'no', '0', 'false'].includes(v)) return false
  return undefined
}

/** `2h`, `45m`, `45min`, `1h30`, `1h30m`, `90` (minutes). */
export function parseDuration(s: string): number | undefined {
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*(?:m|min|mn)?)?$/.exec(s.replace(/\s+/g, ''))
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function firstLine(s: string): string {
  return s.split('\n').map(l => l.trim()).find(Boolean) ?? ''
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
