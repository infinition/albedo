# Register the thumbnail provider from a place no build ever writes to.
#
# The provider used to be registered straight out of the build tree. Explorer
# loads a shell extension into its own process and keeps it loaded, so the very
# file the next build has to overwrite was held open by the desktop: three
# builds in a row failed with "the process cannot access the file", and the only
# way through was to restart Explorer each time.
#
# The fix is one copy. The DLL is stamped into LOCALAPPDATA and the registration
# points there, so Explorer holds a file that nothing rebuilds while the build
# tree stays free. Run this again after rebuilding the provider itself; the
# viewer's own frontend needs nothing here.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-thumbnail-provider.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$built = Join-Path $root "shell-thumbnails\target\release\albedo_thumbnails.dll"
if (-not (Test-Path $built)) {
    throw "DLL introuvable : $built. Compile d'abord shell-thumbnails en release."
}

# The viewer is named rather than copied. The DLL renders nothing itself: it
# runs albedo.exe with --thumbnail and waits for the PNG. Recording the path
# means every build is picked up with nothing to copy afterwards, which a copy
# could not promise. Explorer only spawns the renderer rather than loading it, so
# naming a file in the build tree costs no lock; only the DLL has to be a copy.
$exe = Join-Path $root "src-tauri\target\release\albedo.exe"
if (-not (Test-Path $exe)) {
    throw "albedo.exe introuvable : $exe. Compile d'abord le viewer en release."
}

$home_ = Join-Path $env:LOCALAPPDATA "Albedo\shell"
$stable = Join-Path $home_ "albedo_thumbnails.dll"
New-Item -ItemType Directory -Force -Path $home_ | Out-Null

# Explorer may still hold the previous copy, so a locked target is reported
# rather than thrown: the remedy is one Explorer restart, not a stack trace.
$dllCopiee = $true
try {
    Copy-Item $built $stable -Force
} catch {
    # The DLL is a thin shim and rarely changes, so a locked one is usually the
    # same bytes as the new one: worth saying, not worth stopping for.
    $dllCopiee = $false
    Write-Warning "DLL non remplacee, l'explorateur la tient : $($_.Exception.Message)"
    Write-Warning "Sans importance si elle n'a pas change ; sinon redemarre l'explorateur et relance."
}

$clsid = "{A4E3C1D2-8B57-4F09-9C6E-3D0B2A5F71E4}"
$key = "HKCU:\Software\Classes\CLSID\$clsid\InprocServer32"
if (-not (Test-Path $key)) {
    throw "Le fournisseur n'est pas enregistre. Lance d'abord regsvr32 sur la DLL."
}

$before = (Get-ItemProperty -Path $key).'(default)'
Set-ItemProperty -Path $key -Name "(default)" -Value $stable
Set-ItemProperty -Path $key -Name "ThreadingModel" -Value "Apartment"

# Read by the DLL before it falls back to looking beside itself.
New-Item -Path "HKCU:\Software\Albedo\Shell" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Albedo\Shell" -Name "Renderer" -Value $exe

Write-Host "Fournisseur : $stable$(if (-not $dllCopiee) { '  (copie inchangee)' })"
Write-Host "Avant        : $before"
Write-Host "Moteur       : $exe"
Write-Host ""
Write-Host "Le moteur est designe, pas copie : chaque nouvelle compilation du viewer"
Write-Host "est prise en compte sans rien relancer ici. Ce script n'est a rejouer que"
Write-Host "si la DLL elle-meme change, ou si le viewer change de dossier."
