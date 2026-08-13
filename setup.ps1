#Requires -Version 5.1
<#
  FABULA-LLM-5 — one-shot setup on Windows: clone -> .\setup.ps1 -> serve.

    .\setup.ps1                  install and finish — asks nothing
    .\setup.ps1 -Ask             walk me through the optional extras
    .\setup.ps1 -With browser    add named capabilities
    .\setup.ps1 -All             everything
    .\setup.ps1 -Minimal         core only, without the localhost adapter
    .\setup.ps1 -DepsOnly        dependencies only, skip the engine build

  IT ASKS NOTHING BY DEFAULT, like its POSIX twin and for the same measured reason: the version that
  opened with "Where will your model come from?" made a person answer questions about localhost
  adapters and model ids before they had ever opened the application. Choosing a model happens in the
  app, which has a screen for it.

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
param([switch]$Ask, [switch]$All, [switch]$Minimal, [string]$With = "", [switch]$DepsOnly)
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

# WHAT gets installed is a question, not a default. The manifest marks, per plugin, what THAT PLUGIN
# cannot work without; reading it as what FABULA cannot work without installed 22 dependencies on a
# first run, a 539 MB browser among them. The questions, their prices and the honest reason to decline
# live in plugin/lib/setupgroups.ts - the same file setup.sh reads, so the two platforms cannot end up
# offering people different products.
# The silent default installs the adapter — ours, small, and inert until a local model runs. -Minimal
# is how you decline it.
$ModelSource = if ($Minimal) { "later" } else { "local" }
$Groups = $With
if ($Ask -and -not $All -and -not $Minimal -and $With -eq "") {
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    Write-Host "> Where will your model come from?"
    $srcIds = @(); $n = 0
    foreach ($line in (bun -e 'import { MODEL_SOURCES } from "./plugin/lib/setupgroups"; for (const m of MODEL_SOURCES) console.log([m.id, m.label, m.detail].join("|"))')) {
      $f = $line -split '\|'; if ($f.Count -lt 3) { continue }
      $n++; $srcIds += $f[0]
      Write-Host "   $n) $($f[1])"
      Write-Host "      $($f[2])" -ForegroundColor DarkGray
    }
    if ($n -gt 0) {
      $pick = Read-Host "   Choose 1-$n [1]"
      $i = 1; if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $n) { $i = [int]$pick }
      $ModelSource = $srcIds[$i - 1]
    } else { $ModelSource = "local" }

    Write-Host ""
    Write-Host "> Optional capabilities"
    Write-Host "  Say no to anything you are unsure about - each can be added later." -ForegroundColor DarkGray
    $chosen = @()
    foreach ($line in (bun -e 'import { SETUP_GROUPS } from "./plugin/lib/setupgroups"; for (const g of SETUP_GROUPS) console.log([g.id, g.question, g.cost, g.skipIf, g.recommended ? "y" : "n"].join("|"))')) {
      $f = $line -split '\|'; if ($f.Count -lt 5) { continue }
      Write-Host ""
      Write-Host "  $($f[1])"
      Write-Host "  costs: $($f[2])" -ForegroundColor DarkGray
      Write-Host "  skip it if: $($f[3])" -ForegroundColor DarkGray
      $def = $f[4]
      $hint = if ($def -eq "y") { "[Y/n]" } else { "[y/N]" }
      $a = Read-Host "  install it? $hint"
      if ($a -eq "") { $a = $def }
      if ($a -match '^[Yy]') { $chosen += $f[0] }
    }
    $Groups = ($chosen -join ",")
    Write-Host ""
  } else {
    # A prompt nobody can answer is a hang. Fall back to the silent default.
    Write-Host "> Installing without questions (nothing here can answer one)."
  }
}

Write-Host "> 2/5  System dependencies (from the manifest)..."
$depArgs = @(); if ($All) { $depArgs += "--all" } else { $depArgs += "--groups=$Groups" }
try { bun scripts/install-deps.ts @depArgs }
catch { Write-Host "  (some installs failed - see above; this script is re-runnable any time)" }

if (-not $DepsOnly) {
  Write-Host "> 3/5  Engine + shell..."
  # ONE build definition for every platform. This script deliberately does not reimplement the build:
  # build.sh already knows how to produce the engine binary and this platform's shell, and a second copy
  # here would be a second answer to "how is FABULA built" that drifts from the first. The POSIX shell
  # checked above is what runs it.
  & $bash -lc "./build.sh"
  if ($LASTEXITCODE -ne 0) { Write-Host "  x build failed - see the output above" -ForegroundColor Red; exit 1 }
  Write-Host "  engine: bin\fabula.exe"
} else {
  Write-Host "> 3/5  Skipped engine build (-DepsOnly)."
}

Write-Host "> 4/5  Config..."
if (-not (Test-Path "fabula.config.json")) { Copy-Item "fabula.config.example.json" "fabula.config.json" }
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
New-Item -ItemType Directory -Force -Path ".fabula" | Out-Null

# The adapter is what FABULA talks to a model ON THIS MACHINE through. Installing it for someone whose
# model lives behind a corporate gateway registers a logon task they will never use.
if ($ModelSource -eq "local" -or $All) {
  Write-Host "> 5/5  Local-model adapter (:1235)..."
  # Registered as a logon task by the same installer the other platforms use; it refuses to touch a live
  # adapter, because anything answering on that port already owns it.
  try { bun scripts/install-adapter-service.ts }
  catch { Write-Host "  (adapter service not installed - check: bun scripts/install-adapter-service.ts --status)" }
} else {
  Write-Host "> 5/5  Local-model adapter: skipped - it is only needed for a model running on this machine."
  Write-Host "  Changed your mind? bun scripts/install-adapter-service.ts" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Setup complete."
switch ($ModelSource) {
  "local"    { Write-Host "  1. Open LM Studio, download a tool-calling model, start its server." }
  "endpoint" { Write-Host "  1. Put your key in .env and describe the endpoint in fabula.config.json (it ships a filled-in example)." }
  default    { Write-Host "  1. Add a model when you want one: in the app, Manage models -> Custom provider." }
}
Write-Host "  2. bin\fabula.exe serve --port 4096   then open http://127.0.0.1:4096"
Write-Host ""
Write-Host "  Add a capability later:  .\setup.ps1 -With browser   (or: browser,search,sandbox,voice,go)" -ForegroundColor DarkGray
