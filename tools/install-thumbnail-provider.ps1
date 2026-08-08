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

# The viewer goes with it. The DLL renders nothing itself: it looks for
# albedo.exe beside itself or one folder up, runs it with --thumbnail and waits
# for the PNG. Copying the DLL alone to a folder with no executable in it left
# the provider unable to find a renderer, so Explorer got a failure for every
# model and drew the generic icon instead. Both files move together or neither
# does. It also finishes the job the DLL started: with the executable copied
# too, nothing in the build tree is held open by the desktop.
$exe = Join-Path $root "src-tauri\target\release\albedo.exe"
if (-not (Test-Path $exe)) {
    throw "albedo.exe introuvable : $exe. Compile d'abord le viewer en release."
}

$home_ = Join-Path $env:LOCALAPPDATA "Albedo\shell"
$stable = Join-Path $home_ "albedo_thumbnails.dll"
New-Item -ItemType Directory -Force -Path $home_ | Out-Null

# Explorer may still hold the previous copy, so a locked target is reported
# rather than thrown: the remedy is one Explorer restart, not a stack trace.
try {
    Copy-Item $built $stable -Force
    Copy-Item $exe (Join-Path $home_ "albedo.exe") -Force
} catch {
    Write-Warning "Copie impossible : $($_.Exception.Message)"
    Write-Warning "Ferme Albedo, redemarre l'explorateur, puis relance ce script."
    exit 1
}

$clsid = "{A4E3C1D2-8B57-4F09-9C6E-3D0B2A5F71E4}"
$key = "HKCU:\Software\Classes\CLSID\$clsid\InprocServer32"
if (-not (Test-Path $key)) {
    throw "Le fournisseur n'est pas enregistre. Lance d'abord regsvr32 sur la DLL."
}

$before = (Get-ItemProperty -Path $key).'(default)'
Set-ItemProperty -Path $key -Name "(default)" -Value $stable
Set-ItemProperty -Path $key -Name "ThreadingModel" -Value "Apartment"

Write-Host "Avant : $before"
Write-Host "Apres : $stable"
Write-Host "Viewer : $(Join-Path $home_ 'albedo.exe')"
Write-Host ""
Write-Host "Redemarre l'explorateur une fois pour qu'il lache l'ancienne DLL."
Write-Host "Les compilations suivantes ne seront plus bloquees."
Write-Host "A relancer apres chaque build, les deux copies etant des instantanes."
