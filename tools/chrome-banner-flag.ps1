<#
.SYNOPSIS
  Add or remove --silent-debugger-extension-api on every way Chrome/Edge gets launched
  (taskbar pin, Start menu and desktop shortcuts, and the http/https link handler).

.DESCRIPTION
  The switch hides Chrome's "... started debugging this browser" banner for EVERY extension
  that uses the debugger permission, not just Locale Jacket. Only use it if you trust all
  installed extensions.

  Default action is -Status (read-only). -Apply edits shortcuts and the per-user link handler
  (HKCU) and writes a backup. -Revert restores from that backup. Shortcuts under
  %ProgramData% need an elevated PowerShell; without it they are reported and skipped.

  Chrome only reads launch flags when its first process starts: quit Chrome completely
  (including the tray icon / background apps) after applying, then check with -Status or
  chrome://version (Command Line row).

.EXAMPLE
  .\chrome-banner-flag.ps1                     # status
  .\chrome-banner-flag.ps1 -Apply              # Chrome
  .\chrome-banner-flag.ps1 -Apply -Browser Both
  .\chrome-banner-flag.ps1 -Revert
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
  [Parameter(ParameterSetName = 'Apply')][switch]$Apply,
  [Parameter(ParameterSetName = 'Revert')][switch]$Revert,
  [ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Chrome',
  # Testing hooks: scan only these folders / use another registry base instead of the real ones.
  [string[]]$ShortcutFolders,
  [string]$ClassesBase = 'HKCU:\Software\Classes',
  [string]$BackupFile = (Join-Path $env:LOCALAPPDATA 'LocaleJacket\banner-flag-backup.json')
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$Flag = '--silent-debugger-extension-api'

$targets = @()
if ($Browser -in 'Chrome', 'Both') { $targets += @{ Name = 'Chrome'; Exe = 'chrome.exe'; ProgId = 'ChromeHTML'; Process = 'chrome' } }
if ($Browser -in 'Edge', 'Both') { $targets += @{ Name = 'Edge'; Exe = 'msedge.exe'; ProgId = 'MSEdgeHTM'; Process = 'msedge' } }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$shell = New-Object -ComObject WScript.Shell

function Get-ShortcutFolders {
  if ($ShortcutFolders) { return $ShortcutFolders }
  @(
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:PUBLIC 'Desktop')
  ) | Where-Object { $_ -and (Test-Path $_) }
}

function Get-BrowserShortcuts($t) {
  foreach ($folder in Get-ShortcutFolders) {
    # Taskbar/Quick Launch folders hold the .lnk files directly; Start menu may nest one level.
    Get-ChildItem -Path $folder -Filter *.lnk -File -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object {
      $lnk = $shell.CreateShortcut($_.FullName)
      if ($lnk.TargetPath -and ([IO.Path]::GetFileName($lnk.TargetPath) -ieq $t.Exe)) {
        [pscustomobject]@{ Path = $_.FullName; Arguments = $lnk.Arguments; HasFlag = $lnk.Arguments -match [regex]::Escape($Flag); Lnk = $lnk }
      }
    }
  }
}

function Test-Writable($path) {
  if ($isAdmin) { return $true }
  return -not $path.StartsWith($env:ProgramData, [StringComparison]::OrdinalIgnoreCase) -and
         -not $path.StartsWith($env:PUBLIC, [StringComparison]::OrdinalIgnoreCase)
}

function Get-HandlerCommand($progId) {
  # Effective (merged HKCU+HKLM) command, plus the per-user override if one exists.
  $user = Join-Path $ClassesBase "$progId\shell\open\command"
  $userValue = if (Test-Path $user) { (Get-Item $user).GetValue('') } else { $null }
  $merged = $null
  try { $merged = (Get-Item "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command").GetValue('') } catch { }
  if ($ClassesBase -ne 'HKCU:\Software\Classes') { $merged = $userValue }  # test mode: only the test base
  [pscustomobject]@{ UserKey = $user; UserValue = $userValue; Effective = if ($userValue) { $userValue } else { $merged } }
}

function Add-FlagToCommand([string]$cmd) {
  if (-not $cmd -or $cmd -match [regex]::Escape($Flag)) { return $cmd }
  if ($cmd -match '^\s*("[^"]+"|\S+)(.*)$') { return "$($Matches[1]) $Flag$($Matches[2])" }
  return $cmd
}

function Get-RunningBrowser($t) {
  Get-CimInstance Win32_Process -Filter "Name='$($t.Exe)'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { [pscustomobject]@{ Pid = $_.ProcessId; HasFlag = $_.CommandLine -match [regex]::Escape($Flag) } }
}

# --------------------------------------------------------------------- status
if ($PSCmdlet.ParameterSetName -eq 'Status') {
  foreach ($t in $targets) {
    Write-Host "== $($t.Name)" -ForegroundColor Cyan
    $found = @(Get-BrowserShortcuts $t)
    if (-not $found) { Write-Host '  shortcuts: none found' }
    foreach ($s in $found) { Write-Host ("  [{0}] {1}" -f ($(if ($s.HasFlag) { 'flag' } else { '----' })), $s.Path) }
    $h = Get-HandlerCommand $t.ProgId
    Write-Host ("  link handler ({0}): {1}" -f $t.ProgId, $(if ($h.Effective -and $h.Effective -match [regex]::Escape($Flag)) { 'flag' } elseif ($h.Effective) { 'no flag' } else { 'not registered' }))
    $running = @(Get-RunningBrowser $t)
    if (-not $running) { Write-Host '  running: no' }
    else { Write-Host ("  running: yes, started {0} the flag" -f $(if ($running | Where-Object HasFlag) { 'WITH' } else { 'WITHOUT' })) }
  }
  Write-Host "`nRun with -Apply to add the flag, -Revert to undo. Backup: $BackupFile"
  return
}

# ---------------------------------------------------------------------- apply
if ($Apply) {
  Write-Warning "This hides Chrome's debugging banner for ALL extensions with the debugger permission."
  $backup = @{ created = (Get-Date).ToString('o'); shortcuts = @(); handlers = @() }
  if (Test-Path $BackupFile) { $backup = Get-Content $BackupFile -Raw | ConvertFrom-Json | ForEach-Object { @{ created = $_.created; shortcuts = @($_.shortcuts); handlers = @($_.handlers) } } }

  foreach ($t in $targets) {
    foreach ($s in Get-BrowserShortcuts $t) {
      if ($s.HasFlag) { Write-Host "  already set: $($s.Path)"; continue }
      if (-not (Test-Writable $s.Path)) { Write-Warning "  needs an elevated PowerShell, skipped: $($s.Path)"; continue }
      if (-not ($backup.shortcuts | Where-Object { $_.path -eq $s.Path })) { $backup.shortcuts += @{ path = $s.Path; arguments = $s.Arguments } }
      $s.Lnk.Arguments = ("$Flag $($s.Arguments)").Trim()
      $s.Lnk.Save()
      Write-Host "  updated shortcut: $($s.Path)"
    }
    $h = Get-HandlerCommand $t.ProgId
    if (-not $h.Effective) { Write-Host "  $($t.ProgId) link handler not registered; skipped"; continue }
    $new = Add-FlagToCommand $h.Effective
    if ($new -eq $h.Effective) { Write-Host "  link handler already set ($($t.ProgId))"; continue }
    if (-not ($backup.handlers | Where-Object { $_.key -eq $h.UserKey })) { $backup.handlers += @{ key = $h.UserKey; value = $h.UserValue } }
    New-Item -Path $h.UserKey -Force | Out-Null
    Set-Item -Path $h.UserKey -Value $new
    Write-Host "  updated link handler (per-user): $($t.ProgId)"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $BackupFile) | Out-Null
  $backup | ConvertTo-Json -Depth 5 | Set-Content -Path $BackupFile -Encoding UTF8
  Write-Host "`nBackup written to $BackupFile"
  foreach ($t in $targets) {
    if (@(Get-RunningBrowser $t | Where-Object { -not $_.HasFlag })) {
      Write-Warning "$($t.Name) is running without the flag. Quit it completely (also 'Continue running background apps' in Settings > System, and the tray icon), then start it from a shortcut."
    }
  }
  Write-Host 'Verify afterwards: chrome://version > Command Line, or run this script without arguments.'
  return
}

# --------------------------------------------------------------------- revert
if ($Revert) {
  if (-not (Test-Path $BackupFile)) { Write-Host "No backup at $BackupFile; nothing to revert."; return }
  $backup = Get-Content $BackupFile -Raw | ConvertFrom-Json
  foreach ($s in @($backup.shortcuts)) {
    if (-not (Test-Path $s.path)) { Write-Host "  gone: $($s.path)"; continue }
    if (-not (Test-Writable $s.path)) { Write-Warning "  needs an elevated PowerShell, skipped: $($s.path)"; continue }
    $lnk = $shell.CreateShortcut($s.path)
    $lnk.Arguments = [string]$s.arguments
    $lnk.Save()
    Write-Host "  restored shortcut: $($s.path)"
  }
  foreach ($h in @($backup.handlers)) {
    if ($null -eq $h.value) {
      # There was no per-user override before: remove ours (shell\open\command and empty parents we created).
      if (Test-Path $h.key) { Remove-Item -Path $h.key -Recurse -Force }
      $parent = Split-Path (Split-Path (Split-Path $h.key))   # ...\<ProgId>
      if ((Test-Path $parent) -and -not (Get-ChildItem $parent -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.GetValueNames().Count -gt 0 })) {
        Remove-Item -Path $parent -Recurse -Force
      }
    } else {
      Set-Item -Path $h.key -Value $h.value
    }
    Write-Host "  restored link handler: $($h.key)"
  }
  Remove-Item $BackupFile -Force
  Write-Host 'Reverted. Restart Chrome for it to take effect.'
}
