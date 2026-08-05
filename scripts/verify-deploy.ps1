#Requires -Version 5.1
<#
  Is the engine binary the app actually runs BUILT FROM the engine source in this tree?

  The PowerShell twin of verify-deploy.sh, and it exists for one reason: on Windows the POSIX shell is a
  dependency the user installs, so the check that decides whether a deploy is real must not itself depend
  on it. A guard that cannot run on the platform it guards is not a guard.

  It asks the same three questions in the same order, and reports the same two verdicts:

    1. Does bin\fabula.exe exist and answer --version?
    2. Is any engine source NEWER than it? (if so the binary cannot contain that source)
    3. Does the version the source DECLARES sit inside each of the three artifacts?

  Freshness by NUMBER, not only by timestamp: a binary built five minutes ago from some OTHER checkout is
  newer than every source file here and carries every marker. The version string is the one thing it
  cannot fake.

      pwsh scripts/verify-deploy.ps1 [path-to-tree]
#>
param([string]$Root)
$ErrorActionPreference = "Continue"
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = (Resolve-Path $Root).Path

$script:fail = 0
function Say($m) { Write-Host $m }
function Ok($m)  { Write-Host "   [ok] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "   [!!] $m" -ForegroundColor Red; $script:fail = 1 }

$Bin = Join-Path $Root "bin\fabula.exe"

Say "-- the binary exists and runs"
if (-not (Test-Path $Bin)) {
  Bad "no executable at bin\fabula.exe - the app has nothing to run"
  Write-Host ""; Write-Host "DEPLOY: STALE"; exit 1
}
$ver = (& $Bin --version 2>$null) -join ""
if ($ver) { Ok "bin\fabula.exe runs (version $ver)" } else { Bad "bin\fabula.exe did not answer --version" }

Say "-- no engine source is newer than the binary"
# The general check: if ANY source file postdates the build, the binary cannot contain it. Catches every
# future change that edits the engine and forgets to rebuild, without naming a single symbol.
$binTime = (Get-Item $Bin).LastWriteTime
# Forward slashes deliberately: PowerShell accepts them on Windows, and this is the engine tree's real
# name — spelling it with backslashes made it a different string to every tool that reads this repo.
$src = Join-Path $Root "engine/packages/opencode/src"
$newer = @()
if (Test-Path $src) {
  $newer = Get-ChildItem -Path $src -Recurse -File -Include *.ts, *.tsx -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -gt $binTime } | Select-Object -First 5
}
if ($newer.Count -gt 0) {
  Bad "engine source is NEWER than the deployed binary - the app is running code you have not built:"
  $newer | ForEach-Object { Write-Host ("        " + $_.FullName.Substring($Root.Length + 1)) }
} else {
  Ok "every engine source file predates the build"
}

Say "-- every artifact carries the version the source declares"
$changelog = Join-Path $Root "engine\packages\app\src\data\fabula-changelog.ts"
$srcVer = $null
if (Test-Path $changelog) {
  $m = Select-String -Path $changelog -Pattern '^export const FABULA_VERSION = "(.*)"$' | Select-Object -First 1
  if ($m) { $srcVer = $m.Matches[0].Groups[1].Value }
}
if (-not $srcVer) {
  Bad "no FABULA_VERSION in the changelog source - nothing to hold the artifacts to"
} else {
  # 1) the built frontend bundle
  $dist = Get-ChildItem -Path (Join-Path $Root "engine\packages\app\dist\assets") -Filter "index-*.js" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $dist) {
    Bad "frontend dist has no assets\index-*.js - the frontend was never built (source declares $srcVer)"
  } elseif (Select-String -Path $dist.FullName -SimpleMatch -Pattern """$srcVer""" -Quiet) {
    Ok "frontend dist carries $srcVer ($($dist.Name))"
  } else {
    Bad "frontend dist carries a different version, source declares $srcVer ($($dist.Name))"
  }

  # 2) the bytes of the engine binary itself
  $bytes = [System.IO.File]::ReadAllBytes($Bin)
  $needle = [System.Text.Encoding]::UTF8.GetBytes("""$srcVer""")
  $found = $false
  for ($i = 0; $i -le $bytes.Length - $needle.Length; $i++) {
    if ($bytes[$i] -eq $needle[0]) {
      $hit = $true
      for ($j = 1; $j -lt $needle.Length; $j++) { if ($bytes[$i + $j] -ne $needle[$j]) { $hit = $false; break } }
      if ($hit) { $found = $true; break }
    }
  }
  if ($found) { Ok "engine binary carries $srcVer" } else { Bad "engine binary does not carry $srcVer" }

  # 3) THE THIRD CARRIER - the desktop shell's own manifest. Its ABSENCE is a finding, never a skip: a
  # check that quietly disappears on a platform reads exactly like one that passed.
  $third = Join-Path $Root "dist\fabula.version"
  if (-not (Test-Path $third)) {
    Bad "no installer manifest at dist\fabula.version - the desktop shell was never built (source declares $srcVer)"
  } else {
    $got = (Get-Content $third -Raw).Trim()
    if ($got -eq $srcVer) { Ok "installer manifest carries $srcVer" }
    else { Bad "installer manifest carries $got, source declares $srcVer" }
  }
}

Write-Host ""
if ($script:fail -eq 0) { Write-Host "DEPLOY: FRESH - the app runs this tree's engine" }
else { Write-Host "DEPLOY: STALE - rebuild before claiming a wave is shipped" }
exit $script:fail
