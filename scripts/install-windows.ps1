# Installs WatchTimeline for Premiere Pro and After Effects on Windows,
# and the Claude skill "watch-timeline" for Claude Code.
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:APPDATA 'Adobe\CEP\extensions\WatchTimeline'
$skillSrc = Join-Path $src 'skill\watch-timeline'
$skillDest = Join-Path $env:USERPROFILE '.claude\skills\watch-timeline'

# Unsigned extensions need PlayerDebugMode (CSXS 9 = 2020, 12 = 2025+).
foreach ($v in 9, 10, 11, 12, 13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -Type String
}

if (Test-Path $dest) {
  Write-Host "WatchTimeline is already installed at: $dest"
  Write-Host 'Delete that folder first to replace it.'
  exit 1
}
New-Item -ItemType Directory -Path $dest -Force | Out-Null
foreach ($item in 'CSXS', 'client', 'host', 'lib', 'skill', 'LICENSE') {
  Copy-Item -Path (Join-Path $src $item) -Destination $dest -Recurse
}
Write-Host "Copied the extension to $dest"

$foreign = (Test-Path $skillDest) -and -not (Select-String -Path (Join-Path $skillDest 'SKILL.md') -Pattern '^name: watch-timeline' -Quiet -ErrorAction SilentlyContinue)
if ($foreign) {
  Write-Host "Claude skill: another folder is at $skillDest, left as it is."
} else {
  if (Test-Path $skillDest) { Remove-Item -Path $skillDest -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path -Parent $skillDest) -Force | Out-Null
  Copy-Item -Path $skillSrc -Destination $skillDest -Recurse
  Write-Host "Installed the Claude skill to $skillDest"
}

Write-Host ''
Write-Host '1. Restart Premiere Pro / After Effects, then open Window > Extensions > WatchTimeline.'
Write-Host '2. Restart Claude Code. Tell Claude: /watch-timeline'
