# Kills a command line the gate refuses as soon as it appears anywhere below one process.
# A worker's shell is not the tool that runs the gate, so nothing checks a command line before the process starts:
# this script is the check, and it runs where PATH and an absolute path make no difference. Exit is by -Force.
# Rules are plain text, one regular expression per line: a JSON file cannot carry \b without an escape error.
# Only an interpreter runs a command line. A notifier, a grep or an editor that merely quotes one is a by-stander:
# killing it protects nothing and once killed the very message that reported the refusal, so names filter first.
param([int]$RootPid,[string]$RulesPath,[string]$LogPath,[int]$IntervalMs = 800)
$patterns = @(Get-Content -Path $RulesPath | Where-Object { $_ -match '\S' -and -not $_.StartsWith('#') })
$own = $PID
# A command line only exists to be run by one of these; everything else is a carrier of text about a command.
$interpreters = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'dash.exe', 'zsh.exe')
# Names that quote command lines by design and must never be mistaken for one.
$byStanders = @('lark-bot.exe', 'lark-bot')
while ($true) {
  $procs = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine -ErrorAction SilentlyContinue
  $parentOf = @{}
  foreach ($p in $procs) { $parentOf[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  foreach ($p in $procs) {
    $id = [int]$p.ProcessId
    if ($id -eq $own -or $id -eq $RootPid) { continue }
    $cur = [int]$p.ParentProcessId
    $depth = 0
    $descendant = $false
    while ($cur -gt 0 -and $depth -lt 32) {
      if ($cur -eq $RootPid) { $descendant = $true; break }
      if (-not $parentOf.ContainsKey($cur)) { break }
      $cur = $parentOf[$cur]
      $depth++
    }
    if (-not $descendant) { continue }
    $name = ([string]$p.Name).ToLowerInvariant()
    if ($byStanders -contains $name) { continue }
    if (-not ($interpreters -contains $name)) { continue }
    $line = "$name $($p.CommandLine)"
    if ($line -like '*process-guard.ps1*') { continue }
    foreach ($pattern in $patterns) {
      if ($line -match $pattern) {
        $stamp = (Get-Date).ToString('o')
        $safeLine = $line.Replace('\\', '/').Replace('"', "'")
        if ($safeLine.Length -gt 200) { $safeLine = $safeLine.Substring(0, 200) }
        $safeRule = $pattern.Replace('\\', '/').Replace('"', "'")
        $entry = '{"at":"' + $stamp + '","pid":' + $id + ',"rule":"' + $safeRule + '","line":"' + $safeLine + '"}'
        Add-Content -Path $LogPath -Value $entry -Encoding utf8
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
