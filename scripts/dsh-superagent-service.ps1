<#
.SYNOPSIS
  Registers the dsh-superagent profile to start when the user logs in, and reports whether it answers.

.DESCRIPTION
  `scripts/dsh-superagent` controls the service on Linux and macOS through tmux. Windows has neither `ps` nor `tmux`,
  so this script covers the same ground with the tools Windows ships: a per-user scheduled task, or a Windows service
  under WinSW when an elevated shell is available.

  `plan` prints every command the other actions run and changes nothing at all; it describes the install, which is what
  a person deciding on a method needs to see. `install`, `uninstall`, `start` and `stop` run exactly those commands.

.PARAMETER Action
  plan | install | uninstall | start | stop | status. `keepalive` is what the watchdog task runs: start the
  profile only if its port is not listening. `supervise` is a resident loop that does the same every ten seconds,
  which is short enough to bring a crashed profile back inside half a minute.

.PARAMETER Method
  startup (a per-user Run key, no administrator rights, starts at logon), watchdog (a per-user task every minute
  that restarts the profile when its port stops answering), supervise (a per-user Run key that starts the resident
  loop instead of the profile, so a crash comes back in about ten seconds), task (a logon task, which this machine
  reserves to administrators) or service (a Windows service under WinSW, elevated shell).

.PARAMETER Dsh
  The dsh executable to start; defaults to `dsh.cmd` on PATH, then `dsh.exe`, `dsh`, `dsh.ps1`. A scheduled task and a
  service must both start a real executable, so a `.ps1` shim is started through powershell.exe.

.PARAMETER WinSW
  The WinSW executable, for -Method service. Its XML beside it must name the service DshSuperAgent.

.PARAMETER StateDir
  The profile's state directory, for -Method supervise. A process killed with no chance to clean up leaves the lock
  beside it, and a start that keeps waiting for that lock answers 404 on every orchestrator route instead of mounting.
  The loop removes the lock it finds while nothing is serving, so the restarted profile can take it.

.PARAMETER Box
  A Sandboxie box name, for -Method supervise. The whole instance, the workers it starts included, then runs
  inside that box; the box must already allow the paths the profile writes through OpenFilePath. Empty starts
  the profile on the host, as before.

.PARAMETER LogDir
  Where the resident loop keeps its own log and the box launcher, for -Method supervise. A service account has no
  LOCALAPPDATA, so the default falls back to ProgramData; name a directory the box already allows through
  OpenFilePath, or the launcher lands in the sandbox and the box never finds it.
#>
[CmdletBinding()]
param(
  [ValidateSet('plan', 'install', 'uninstall', 'start', 'stop', 'status', 'keepalive', 'supervise')]
  [string]$Action = 'plan',
  [ValidateSet('task', 'startup', 'watchdog', 'supervise', 'service')]
  [string]$Method = 'task',
  [string]$TaskName = 'DshSuperAgent',
  [string]$Profile = 'superagent',
  [string]$Dsh = '',
  [string]$WinSW = 'winsw.exe',
  [int]$Port = 3082,
  [string]$StateDir = '',
  [string]$Box = '',
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

# A service account has no LOCALAPPDATA, so the loop's own log and the box launcher need a home.
function Resolve-LogDir([string]$Given) {
  if ($Given -ne '') { return $Given }
  if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'dsh-superagent') }
  if ($env:ProgramData) { return (Join-Path $env:ProgramData 'dsh-superagent') }
  return (Join-Path $env:TEMP 'dsh-superagent')
}
$logHome = Resolve-LogDir $LogDir

function Resolve-Dsh([string]$Given) {
  if ($Given -ne '') { return $Given }
  foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh', 'dsh.ps1')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -ne $null) { return $command.Source }
  }
  return '<dsh>'
}

$dshPath = Resolve-Dsh $Dsh
$arguments = '--profile ' + $Profile + ' --no-open'
# A logon task and a service both start an executable; a `.ps1` shim is started through powershell.exe instead.
$startCommand = if ($dshPath -match '\.ps1$') {
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $dshPath + '" ' + $arguments
} else {
  '"' + $dshPath + '" ' + $arguments
}
$execute = if ($dshPath -match '\.ps1$') { 'powershell.exe' } else { $dshPath }
$executeArguments = if ($dshPath -match '\.ps1$') { '-NoProfile -ExecutionPolicy Bypass -File "' + $dshPath + '" ' + $arguments } else { $arguments }
# A box wraps the whole instance, workers included. Sandboxie starts a command line rather than a program, so the
# profile runs through a launcher this script writes and the box is named once.
$startExe = 'C:\Program Files\Sandboxie-Plus\Start.exe'
$boxLauncher = Join-Path $logHome 'box-launch.cmd'
if ($Box) {
  $execute = $startExe
  $executeArguments = '/box:' + $Box + ' /silent cmd.exe /d /s /c "' + $boxLauncher + '"'
}

function Write-BoxLauncher {
  $dir = Split-Path -Parent $boxLauncher
  $null = New-Item -ItemType Directory -Force -Path $dir
  $body = @(
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    # A fresh file per launch: a log a crashed instance still holds open cannot be reopened, and a silent
    # redirection failure looks exactly like an instance that never starts.
    ('"' + $dshPath + '" ' + $arguments + ' > "' + (Join-Path $dir ('box-run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')) + '" 2>&1')
  )
  Set-Content -Path $boxLauncher -Value $body -Encoding Ascii
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$keepalive = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $PSCommandPath + ' -Action keepalive -Method startup'
# The resident loop starts the same way, at logon, and restarts the profile itself on every tick.
$supervise = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $PSCommandPath + ' -Action supervise -Method startup'
if ($LogDir -ne '') { $supervise = $supervise + ' -LogDir "' + $LogDir + '"' }
if ($StateDir) { $supervise = $supervise + ' -StateDir "' + $StateDir + '"' }
$superviseStart = "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" + $PSCommandPath + "','-Action','supervise'"
if ($StateDir) { $superviseStart = $superviseStart + ",'-StateDir','" + $StateDir + "'" }
if ($Box) { $superviseStart = $superviseStart + ",'-Box','" + $Box + "'" }
if ($Box) { $supervise = $supervise + ' -Box "' + $Box + '"' }
$superviseStart = $superviseStart + ' -WindowStyle Hidden'
# Stopping the loop is its own command because stopping the profile is what "startup" stop means.
$stopLoop = 'Get-CimInstance Win32_Process -Filter "Name=''powershell.exe''" | Where-Object { $_.CommandLine -like ''*-Action supervise*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'

# Each action is a list of command lines, so `plan` prints exactly what `install` runs and a person can paste it.
# `plan` describes the install, which is what a person deciding on the method needs to see.
function Get-Commands([string]$Which) {
  switch ($Method) {
    'task' {
      switch ($Which) {
        'install'   {
          # Built as separate strings: an unparenthesized `+` chain inside @() joins the elements instead of listing them.
          $newAction = "New-ScheduledTaskAction -Execute '" + $execute + "' -Argument '" + $executeArguments + "'"
          $body = @(
            # Names other than `$action`: this script's own `$Action` parameter carries a ValidateSet, and
            # Invoke-Expression assigns into the same scope, so `$action = New-ScheduledTaskAction …` fails validation.
            ("`$taskAction = " + $newAction),
            "`$taskTrigger = New-ScheduledTaskTrigger -AtLogOn",
            "`$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
            ("Register-ScheduledTask -TaskName '" + $TaskName + "' -Action `$taskAction -Trigger `$taskTrigger -Settings `$taskSettings -Force")
          )
          return $body
        }
        'uninstall' { return @("Unregister-ScheduledTask -TaskName '" + $TaskName + "' -Confirm:`$false") }
        'start'     { return @("Start-ScheduledTask -TaskName '" + $TaskName + "'") }
        'stop'      { return @("Stop-ScheduledTask -TaskName '" + $TaskName + "'") }
        default     { return @() }
      }
    }
    'startup' {
      switch ($Which) {
        'install'   {
          return @("New-ItemProperty -Path '" + $runKey + "' -Name '" + $TaskName + "' -Value '" + $startCommand + "' -PropertyType String -Force")
        }
        'uninstall' { return @("Remove-ItemProperty -Path '" + $runKey + "' -Name '" + $TaskName + "' -ErrorAction SilentlyContinue") }
        'start'     { return @("Start-Process -FilePath '" + $execute + "' -ArgumentList '" + $executeArguments + "' -WindowStyle Hidden") }
        # By its port, not its name: the profile runs as "DSH Tauri", so a name filter misses it while the port is exact.
        'stop'      { return @("Get-NetTCPConnection -LocalPort " + $Port + " -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force }") }
        default     { return @() }
      }
    }
    'watchdog' {
      switch ($Which) {
        # A minute schedule, not a logon trigger: this machine reserves logon triggers to administrators.
        'install'   { return @("schtasks /create /tn '" + $TaskName + "' /tr '" + $keepalive + "' /sc minute /mo 1 /f") }
        'uninstall' { return @("schtasks /delete /tn '" + $TaskName + "' /f") }
        'start'     { return @("schtasks /run /tn '" + $TaskName + "'") }
        'stop'      { return @("schtasks /end /tn '" + $TaskName + "'") }
        default     { return @() }
      }
    }
    'supervise' {
      switch ($Which) {
        # One Run key, no schedule: the loop it starts keeps a one-minute task from being the only recovery.
        'install'   { return @("New-ItemProperty -Path '" + $runKey + "' -Name '" + $TaskName + "' -Value '" + $supervise + "' -PropertyType String -Force") }
        'uninstall' { return @($stopLoop, ("Remove-ItemProperty -Path '" + $runKey + "' -Name '" + $TaskName + "' -ErrorAction SilentlyContinue")) }
        'start'     { return @($superviseStart) }
        'stop'      { return @($stopLoop) }
        default     { return @() }
      }
    }
    'service' {
      switch ($Which) {
        'install'   { return @(("& '" + $WinSW + "' install"), ("& '" + $WinSW + "' start")) }
        'uninstall' { return @(("& '" + $WinSW + "' stop"), ("& '" + $WinSW + "' uninstall")) }
        'start'     { return @("& '" + $WinSW + "' start") }
        'stop'      { return @("& '" + $WinSW + "' stop") }
        default     { return @() }
      }
    }
  }
}

function Show-Status {
  $registered = $false
  $running = $false
  $detail = 'not registered'
  if ($Method -eq 'startup') {
    $value = (Get-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue).$TaskName
    if ($value -ne $null) { $registered = $true; $detail = 'runkey=set' }
  } elseif ($Method -eq 'supervise') {
    $value = (Get-ItemProperty -Path $runKey -Name $TaskName -ErrorAction SilentlyContinue).$TaskName
    $loop = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*-Action supervise*' }).Count -gt 0
    if ($value -ne $null) { $registered = $true; $running = $loop; $detail = "runkey=set loop=$loop" }
  } elseif ($Method -eq 'watchdog') {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -ne $null) { $registered = $true; $running = $task.State -eq 'Running'; $detail = "state=$($task.State)" }
  } elseif ($Method -eq 'task') {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -ne $null) {
      $registered = $true
      $running = $task.State -eq 'Running'
      $detail = "state=$($task.State)"
    }
  } else {
    $service = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
    if ($service -ne $null) { $registered = $true; $running = $service.Status -eq 'Running'; $detail = "status=$($service.Status)" }
  }
  $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  $state = 'unreachable'
  try {
    $response = Invoke-WebRequest "http://127.0.0.1:$Port/orchestrator/api/state" -Headers @{ 'x-orchestrator-request' = '1' } -UseBasicParsing -TimeoutSec 3
    $state = "http $($response.StatusCode)"
  } catch { }
  Write-Output "target=$TaskName registered=$registered running=$running $detail port=$Port listening=$listening state=$state"
  if ($listening -and $state -eq 'http 200') { exit 0 }
  exit 1
}

if ($Action -eq 'supervise') {
  # A resident loop, not a schedule: a task every minute can only promise a restart within a minute, and the
  # startup check wants a crash back inside thirty seconds. The probe is the state API and not the port, because a
  # start that lost the state lock still listens and answers 404 on every orchestrator route: a port probe calls
  # that healthy and never restarts it.
  $logDir = $logHome
  $null = New-Item -ItemType Directory -Force -Path $logDir
  $log = Join-Path $logDir 'supervise.log'
  $lock = if ($StateDir) { $StateDir + '.lock' } else { '' }
  # One loop only. Two loops probe the same port and both clear the same lock, so a single crash gets answered
  # twice and the second start fights the first for the state directory.
  $rivals = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and
    $_.CommandLine -like ('*' + $PSCommandPath + '*') -and
    $_.CommandLine -like '*-Action supervise*'
  })
  if ($rivals.Count -gt 0) {
    Add-Content -Path $log -Value ((Get-Date).ToString('o') + " another supervise loop (" + $rivals[0].ProcessId + ") already watches port $Port; leaving it to that one")
    exit 0
  }
  Add-Content -Path $log -Value ((Get-Date).ToString('o') + " supervise started every 10s on port $Port")
  $degraded = 0
  while ($true) {
    if ($Box) { Write-BoxLauncher }
    $health = 'down'
    try {
      $answer = Invoke-WebRequest ("http://127.0.0.1:" + $Port + "/orchestrator/api/state") -Headers @{ 'x-orchestrator-request' = '1' } -UseBasicParsing -TimeoutSec 5
      if ($answer.StatusCode -eq 200) { $health = 'up' }
    } catch {
      if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { $health = 'degraded' }
    }
    if ($health -eq 'up') {
      $degraded = 0
    } elseif ($health -eq 'degraded') {
      $degraded++
      if ($degraded -eq 1) { Add-Content -Path $log -Value ((Get-Date).ToString('o') + " port $Port answers, but not the state API; watching it") }
      # Three ticks is half a minute of an instance that listens and mounts nothing: a boot finishes well inside that.
      if ($degraded -ge 3) {
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
        if ($lock -and (Test-Path -LiteralPath $lock)) {
          Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
          Add-Content -Path $log -Value ((Get-Date).ToString('o') + " removed $lock, which the instance that could not mount left behind")
        }
        Start-Process -FilePath $execute -ArgumentList $executeArguments -WindowStyle Hidden
        Add-Content -Path $log -Value ((Get-Date).ToString('o') + " restarted a half-booted instance: $execute $executeArguments")
        $degraded = 0
      }
    } else {
      # Nothing answers yet. A lock this young belongs to a start that is still mounting, either the one this loop
      # just made or the one the Run key made at logon: removing it makes that start fail to mount while a second
      # instance fights for the port, which is how two boots ended up sharing one state directory. Only a lock older
      # than the grace, left by a process that died, counts as stale.
      # Inside a box the profile's command line is the launcher's, so the process that holds the lock is matched
    # by the launcher path instead of the profile argument.
    $profileTag = if ($Box) { Split-Path -Leaf $boxLauncher } else { '--profile ' + $Profile }
    $age = -1.0
      if ($lock -and (Test-Path -LiteralPath $lock)) {
        $age = ((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalSeconds
      }
      # The age alone cannot tell a boot in progress from a dead one, because a live instance refreshes the lock's
      # write time every few seconds. A lock fifteen seconds old with nothing answering the port is one whose
      # instance died: the launcher that stayed behind after its profile was killed keeps the process list looking
      # alive, and waiting the old ninety seconds only turned a ten second restart into a minute.
      $alive = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -and
        $_.CommandLine -like ('*' + $profileTag + '*') -and
        $_.CommandLine -notlike '*-Action supervise*'
      }).Count -gt 0
      if ($lock -and (Test-Path -LiteralPath $lock) -and $alive -and $age -lt 15) {
        Add-Content -Path $log -Value ((Get-Date).ToString('o') + " waiting on the instance that holds " + $lock + ": " + [int]$age + "s old and still a process")
      } else {
        if ($lock -and (Test-Path -LiteralPath $lock)) {
          Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
          Add-Content -Path $log -Value ((Get-Date).ToString('o') + " removed $lock, which no running instance holds")
        }
        Start-Process -FilePath $execute -ArgumentList $executeArguments -WindowStyle Hidden
        Add-Content -Path $log -Value ((Get-Date).ToString('o') + " started $execute $executeArguments")
      }
      $degraded = 0
    }
    Start-Sleep -Seconds 10
  }
}

if ($Action -eq 'keepalive') {
  # The watchdog runs this each minute: starting an instance that is already serving would fight over the port.
  if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { exit 0 }
  Start-Process -FilePath $execute -ArgumentList $executeArguments -WindowStyle Hidden
  Write-Output "started $execute $executeArguments"
  exit 0
}

if ($Action -eq 'status') { Show-Status }

$commands = Get-Commands $(if ($Action -eq 'plan') { 'install' } else { $Action })
if ($Action -eq 'plan') {
  Write-Output "# dsh-superagent on Windows: method=$Method target=$TaskName profile=$Profile port=$Port"
  Write-Output "# start: $startCommand"
  if ($Method -eq 'startup') {
    Write-Output '# A per-user Run key needs no administrator rights and starts the profile when this user logs in.'
    Write-Output '# It cannot restart the profile after a crash; that is what a Windows service is for.'
  } elseif ($Method -eq 'supervise') {
    Write-Output '# A per-user resident loop needs no administrator rights: it probes the port every ten seconds and'
    Write-Output '# starts the profile again when the port stops answering, so a crash comes back in about ten seconds.'
    Write-Output '# It leaves the state lock alone while a process still holds the profile, so a start that is mounting is'
    Write-Output '# not mistaken for a crash, and it clears the lock a killed instance left behind.'
  } elseif ($Method -eq 'watchdog') {
    Write-Output '# A per-user task every minute needs no administrator rights: it starts the profile again when the port'
    Write-Output '# stops answering, so a crash comes back within about a minute rather than at the next logon.'
  } elseif ($Method -eq 'task') {
    Write-Output '# A logon trigger belongs to administrators on this machine: use -Method startup where a standard user runs it.'
    Write-Output '# It starts no earlier than the logon, which is what an unattended machine needs a service for instead.'
  } else {
    Write-Output '# A Windows service starts before anyone logs in and must be installed from an elevated shell;'
    Write-Output '# WinSW reads its XML beside it, which must name DshSuperAgent and point at the same start command.'
  }
  foreach ($command in $commands) { Write-Output $command }
  Write-Output "# verify: powershell -NoProfile -File $PSCommandPath -Action status"
  exit 0
}

foreach ($command in $commands) {
  Write-Output "+ $command"
  Invoke-Expression $command
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
    Write-Output "failed with exit code $LASTEXITCODE"
    if ($Method -eq 'service') { Write-Output 'A Windows service needs an elevated shell; reopen one with Run as administrator.' }
    exit $LASTEXITCODE
  }
}
exit 0
