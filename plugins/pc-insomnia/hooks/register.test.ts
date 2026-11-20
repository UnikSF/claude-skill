import { expect, mock, test } from 'claude-code/testing'

import { parseDuration } from './register'

test('durations', async () => {
  expect(parseDuration('2h')).toBe(2 * 3_600_000)
  expect(parseDuration('45m')).toBe(45 * 60_000)
  expect(parseDuration('1h30')).toBe(90 * 60_000)
  expect(parseDuration('90')).toBe(90 * 60_000)
  expect(parseDuration('lid on')).toBe(undefined)
})

test('a turn on Windows starts the PowerShell hold, the lid is swept at start', async ($, on) => {
  const spawned: string[][] = []
  const ran: string[][] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'windows', isHosted: false } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PID: '4242' } }))
  on('command.register', () => ({ value: { command: 'insomnia' } }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'RESULT none\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'PID 77\nAWAKE\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()

  expect(ran.length).toBe(1)
  expect(ran[0]?.[0]).toBe('powershell.exe')
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.[0]).toBe('powershell.exe')
  expect(spawned[0]?.includes('-EncodedCommand')).toBe(true)
})

test('a hosted session does nothing', async ($, on) => {
  const spawned: string[][] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'linux', isHosted: true } }))
  on('process.hookEnv', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'insomnia' } }))
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  expect(spawned.length).toBe(0)
})
