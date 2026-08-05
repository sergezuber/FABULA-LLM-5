#Requires -Version 5.1
<#
  FABULA-LLM-5 — one-shot setup on Windows: clone -> .\setup.ps1 -> serve.

    .\setup.ps1            runtime + dependencies + engine build + config
    .\setup.ps1 -All       also install OPTIONAL dependencies
    .\setup.ps1 -DepsOnly  dependencies only, skip the engine build

  This is the Windows twin of setup.sh, not a port of it: the two scripts do the same six things and
  each does them the way its own platform does. Everything downstream — the dependency manifest, the
  service installer, the scheduler — already answers per platform, so this file stays thin on purpose.

  WHAT WINDOWS NEEDS THAT THE OTHERS DO NOT: a POSIX shell. The harness commits to one shell family
  everywhere, because `lib/cmdguard.ts` and `lib/shelltargets.ts` READ command text to decide what it
  writes to and dials out to, and those readers understand POSIX grammar. Routing commands through
  PowerShell instead would mean a second grammar for every command-safety rule — a supervision layer with
  a hole shaped like whichever platform was added last. Git for Windows ships that shell, and `git` is a
  required dependency anyway, so it costs nothing extra.
#>
param([switch]$All, [switch]$DepsOnly)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

function Need($name, $how) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "  x $name is required and was not found." -ForegroundColor Red
    Write-Host "    $how"
    exit 1
  }
}

Write-Host "> 0/5  Runtime (bun)..."
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Invoke-RestMethod bun.sh/install.ps1 | Invoke-Expression
  $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}
Need bun "install it from https://bun.sh, then re-run this script"

# The POSIX shell, checked HERE rather than discovered later inside a tool call: a missing shell makes
# every bash-shaped tool fail one at a time with a confusing message, instead of once with a clear one.
Write-Host "> 0b/5 POSIX shell (Git for Windows)..."
$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) {
  foreach ($c in @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe")) {
    if (Test-Path $c) { $bash = $c; break }
  }
}
if (-not $bash) {
  Write-Host "  x no POSIX shell found." -ForegroundColor Red
  Write-Host "    winget install Git.Git    (Git for Windows ships the bash the harness runs commands through)"
  Write-Host "    If it lives somewhere unusual, set FABULA_SHELL_BIN to its full path."
  exit 1
}
Write-Host "  shell: $bash"

Write-Host "> 1/5  Plugin dependencies..."
Push-Location plugin; bun install; Pop-Location

Write-Host "> 2/5  System dependencies (from the manifest)..."
$depArgs = @(); if ($All) { $depArgs += "--all" }
try { bun scripts/install-deps.ts @depArgs }
catch { Write-Host "  (some optional dependencies were skipped - re-run with -All, or use install_plugin_deps from chat)" }

if (-not $DepsOnly) {
  Write-Host "> 3/5  Engine..."
  if (-not (Test-Path "bin\fabula.exe")) {
    # Build for THIS platform. The engine's own build script knows every target; --only names one.
    Push-Location engine
    bun install
    Push-Location packages\opencode
    $env:MIMOCODE_CHANNEL = "prod"
    bun run script/build.ts --only=windows-x64
    Pop-Location; Pop-Location
    New-Item -ItemType Directory -Force -Path bin | Out-Null
    Copy-Item "engine\packages\opencode\dist\mimocode-windows-x64\bin\mimo.exe" "bin\fabula.exe" -Force
  }
  Write-Host "  engine: bin\fabula.exe"
} else {
  Write-Host "> 3/5  Skipped engine build (-DepsOnly)."
}

Write-Host "> 4/5  Config..."
if (-not (Test-Path "fabula.config.json")) { Copy-Item "fabula.config.example.json" "fabula.config.json" }
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
New-Item -ItemType Directory -Force -Path ".fabula" | Out-Null

Write-Host "> 5/5  Local-model adapter (:1235)..."
# Registered as a logon task by the same installer the other platforms use; it refuses to touch a live
# adapter, because anything answering on that port already owns it.
try { bun scripts/install-adapter-service.ts }
catch { Write-Host "  (adapter service not installed - check: bun scripts/install-adapter-service.ts --status)" }

Write-Host ""
Write-Host "Setup complete.  ->  bin\fabula.exe serve --port 4096   then open http://127.0.0.1:4096"
Write-Host "  (Load a model in LM Studio, or add a cloud key to .env - the config is fabula.config.json.)"
