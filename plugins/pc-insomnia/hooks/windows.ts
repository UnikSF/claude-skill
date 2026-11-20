// The Windows side, as one PowerShell script run by powershell.exe (Windows
// PowerShell 5.1, present on every Windows 10/11). The mod passes it with
// -EncodedCommand, so no file, no quoting and no execution policy is involved.
//
// Modes:
//   hold    keeps the machine awake (SetThreadExecutionState) for as long as
//           the process lives; with $Lid, also sets "when I close the lid" to
//           "Do nothing" on AC and battery, after journaling the old values.
//           Exits on its own when $WatchPid (Claude Code) is gone or after
//           $MaxHours, and then gives the lid back.
//   release removes $HolderPid from the lid journal and restores the old
//           values once no live holder is left.
//   sweep   the same with no holder: undoes a lid change whose holders all
//           died (crash, kill, reboot). Run at every session start.
//
// The journal (%LOCALAPPDATA%\PcInsomnia\lid.json) is written BEFORE the
// lid setting changes, holds the original AC/DC values and the PIDs of the
// live holders, so two Claude sessions can share the hold and the last one
// out restores. A named mutex guards it.
//
// Lines printed for the mod: "PID <n>", "LID on", "LIDERR <msg>", "AWAKE",
// "TICK" every 10 s (lets the mod's reader stop it), "RESULT <none|shared|restored>",
// "ERR <msg>".

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

Add-Type -Namespace PcInsomnia -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
[DllImport("powrprof.dll")] public static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
[DllImport("powrprof.dll")] public static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
[DllImport("powrprof.dll")] public static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
[DllImport("powrprof.dll")] public static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
[DllImport("powrprof.dll")] public static extern uint PowerWriteACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
[DllImport("powrprof.dll")] public static extern uint PowerWriteDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
'@

$N = [PcInsomnia.Native]
$SubButtons = [Guid]'4f971e89-eebd-4455-a8de-9e59040e7347'
$LidAction  = [Guid]'5ca83367-6e45-459f-a27b-476b1d01c936'
$Dir = Join-Path $env:LOCALAPPDATA 'PcInsomnia'
$Journal = Join-Path $Dir 'lid.json'

function Check([uint32]$r, [string]$what) {
  if ($r -ne 0) {
    if ($r -eq 5) { throw "$what : accès refusé (réglage verrouillé par l'administrateur ?)" }
    throw "$what : erreur $r"
  }
}

function Get-ActiveScheme {
  $p = [IntPtr]::Zero
  Check ($N::PowerGetActiveScheme([IntPtr]::Zero, [ref]$p)) 'PowerGetActiveScheme'
  try { return [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Guid]) }
  finally { [void]$N::LocalFree($p) }
}

function Read-Lid([Guid]$scheme) {
  $sub = $SubButtons; $set = $LidAction
  [uint32]$ac = 0; [uint32]$dc = 0
  Check ($N::PowerReadACValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$sub, [ref]$set, [ref]$ac)) 'lecture capot (secteur)'
  Check ($N::PowerReadDCValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$sub, [ref]$set, [ref]$dc)) 'lecture capot (batterie)'
  return @{ ac = $ac; dc = $dc }
}

function Write-Lid([Guid]$scheme, [uint32]$ac, [uint32]$dc) {
  $sub = $SubButtons; $set = $LidAction
  Check ($N::PowerWriteACValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$sub, [ref]$set, $ac)) 'écriture capot (secteur)'
  Check ($N::PowerWriteDCValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$sub, [ref]$set, $dc)) 'écriture capot (batterie)'
  if ((Get-ActiveScheme) -eq $scheme) {
    Check ($N::PowerSetActiveScheme([IntPtr]::Zero, [ref]$scheme)) 'activation du plan'
  }
}

function Alive([int]$id) { return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

function Read-Journal {
  if (Test-Path -LiteralPath $Journal) { return (Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json) }
  return $null
}

function Save-Journal($j) {
  [void](New-Item -ItemType Directory -Force -Path $Dir)
  $tmp = "$Journal.tmp"
  ($j | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -Force -LiteralPath $tmp -Destination $Journal
}

function Live-Holders($j, [int]$except) {
  return @(@($j.holders) | Where-Object { $null -ne $_ -and [int]$_ -ne $except -and (Alive ([int]$_)) } | ForEach-Object { [int]$_ })
}

function With-Lock([scriptblock]$body) {
  $m = New-Object System.Threading.Mutex($false, 'Local\PcInsomniaLid')
  try {
    try { [void]$m.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { }
    & $body
  } finally {
    try { $m.ReleaseMutex() } catch { }
    $m.Dispose()
  }
}

function Lid-Acquire([int]$holder) {
  With-Lock {
    $j = Read-Journal
    if ($null -eq $j) {
      $s = Get-ActiveScheme
      $v = Read-Lid $s
      $j = [pscustomobject]@{ scheme = $s.ToString(); ac = [uint32]$v.ac; dc = [uint32]$v.dc; holders = @() }
    }
    $j.holders = @(Live-Holders $j 0) + $holder
    Save-Journal $j
    Write-Lid ([Guid]$j.scheme) 0 0
  }
}

function Lid-Release([int]$holder) {
  With-Lock {
    $j = Read-Journal
    if ($null -eq $j) { return 'none' }
    $left = @(Live-Holders $j $holder)
    if ($left.Count -gt 0) {
      $j.holders = $left
      Save-Journal $j
      return 'shared'
    }
    Write-Lid ([Guid]$j.scheme) ([uint32]$j.ac) ([uint32]$j.dc)
    Remove-Item -Force -LiteralPath $Journal
    return 'restored'
  }
}

try {
  switch ($Mode) {
    'hold' {
      # ES_CONTINUOUS | ES_SYSTEM_REQUIRED, plus ES_DISPLAY_REQUIRED for the screen.
      $flags = [uint32]2147483649
      if ($Display) { $flags = [uint32]2147483651 }
      [void]$N::SetThreadExecutionState($flags)
      Say "PID $PID"
      if ($Lid) {
        try { Lid-Acquire $PID; Say 'LID on' } catch { Say "LIDERR $($_.Exception.Message)" }
      }
      Say 'AWAKE'
      $deadline = (Get-Date).AddHours($MaxHours)
      try {
        while ((Get-Date) -lt $deadline) {
          if ($WatchPid -gt 0 -and -not (Alive $WatchPid)) { break }
          Start-Sleep -Seconds 10
          Say 'TICK'
        }
      } finally {
        if ($Lid) { try { [void](Lid-Release $PID) } catch { } }
      }
    }
    'release' { Say "RESULT $(Lid-Release $HolderPid)" }
    'sweep'   { Say "RESULT $(Lid-Release 0)" }
    default   { throw "mode inconnu : $Mode" }
  }
} catch {
  Say "ERR $($_.Exception.Message)"
  exit 1
}
`

export type WinMode = 'hold' | 'release' | 'sweep'

export type WinParams = {
  mode: WinMode
  lid?: boolean
  display?: boolean
  watchPid?: number
  holderPid?: number
  maxHours?: number
}

/** The argv that runs the script in `mode` through powershell.exe. */
export function powershellArgv(p: WinParams): string[] {
  const prelude = [
    `$Mode = '${p.mode}'`,
    `$Lid = $${p.lid === true}`,
    `$Display = $${p.display === true}`,
    `$WatchPid = ${int(p.watchPid)}`,
    `$HolderPid = ${int(p.holderPid)}`,
    `$MaxHours = ${int(p.maxHours ?? 12) || 12}`,
  ].join('\n')

  return [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodeUtf16Base64(`${prelude}\n${SCRIPT}`),
  ]
}

function int(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** What -EncodedCommand takes: the text as UTF-16LE, in base64. */
export function encodeUtf16Base64(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}
