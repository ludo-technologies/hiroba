<#
.SYNOPSIS
  Pack the release build into an unsigned Microsoft Store MSIX.

.DESCRIPTION
  Run after `tauri build`. The Store does not take our MSI/NSIS installer; it
  signs and installs this package itself, so the output is deliberately
  unsigned. Needs makeappx.exe from the Windows SDK (GitHub's windows runners
  ship it). The release workflow runs this in publish-msstore; see
  docs/PACKAGING.md.

.PARAMETER IdentityName
  Package/Identity/Name from Partner Center (Product management → Product
  identity), e.g. LudoTechnologies.Hiroba.
.PARAMETER Publisher
  Package/Identity/Publisher from the same page, CN=<guid>.
.PARAMETER Version
  Release version x.y.z; the manifest gets x.y.z.0.
.PARAMETER BinDir
  Directory holding exactly one .exe, the tauri build output. Defaults to
  target\release next to this script's parent.
.PARAMETER OutDir
  Where the .msix lands. Defaults to target\release\bundle\msix.
#>
param(
  [Parameter(Mandatory)] [string] $IdentityName,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $Version,
  [string] $BinDir = '',
  [string] $OutDir = ''
)
$ErrorActionPreference = 'Stop'

$tauriDir = Split-Path -Parent $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be x.y.z (got '$Version'); prereleases have no Store package"
}
if ($Publisher -notmatch '^CN=') {
  throw "Publisher must be the Partner Center value, CN=<guid> (got '$Publisher')"
}
if (-not $BinDir) { $BinDir = Join-Path $tauriDir 'target\release' }
if (-not $OutDir) { $OutDir = Join-Path $tauriDir 'target\release\bundle\msix' }

$exes = @(Get-ChildItem -Path $BinDir -Filter '*.exe' -File)
if ($exes.Count -ne 1) {
  throw "expected exactly one .exe in $BinDir, found $($exes.Count): $($exes.Name -join ', ')"
}

$stage = Join-Path $OutDir 'stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path (Join-Path $stage 'Assets') | Out-Null

# The exe name is what Task Manager shows; the MSI installs it as Hiroba.exe too.
Copy-Item $exes[0].FullName (Join-Path $stage 'Hiroba.exe')
foreach ($logo in 'StoreLogo', 'Square44x44Logo', 'Square150x150Logo') {
  Copy-Item (Join-Path $tauriDir "icons\$logo.png") (Join-Path $stage "Assets\$logo.png")
}

$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'AppxManifest.xml')
$manifest = $manifest.Replace('@@IDENTITY_NAME@@', $IdentityName).Replace('@@PUBLISHER@@', $Publisher).Replace('@@VERSION@@', "$Version.0")
if ($manifest.Contains('@@')) { throw 'unfilled placeholder in AppxManifest.xml' }
[IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

# makeappx lives in the Windows SDK; take the newest installed kit.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\makeappx.exe" |
  Sort-Object { [version] $_.Directory.Parent.Name } -Descending |
  Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found; install the Windows 10/11 SDK' }

$out = Join-Path $OutDir "Hiroba_${Version}_x64.msix"
& $makeappx.FullName pack /o /d $stage /p $out
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }
Write-Host "Packed $out"
