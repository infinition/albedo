#!/usr/bin/env python3
"""Build a Quick Look app extension with the installed macOS SDK."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
source = root / "platform/macos"
bundle = source / "build/AlbedoThumbnail.appex/Contents"
bundle.mkdir(parents=True, exist_ok=True)
(bundle / "MacOS").mkdir(exist_ok=True)
(bundle / "Resources").mkdir(exist_ok=True)
shutil.copytree(root / "dist", bundle / "Resources/dist", dirs_exist_ok=True)
shutil.copyfile(source / "ThumbnailInfo.plist", bundle / "Info.plist")
sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
target = os.environ.get("TAURI_ENV_TARGET_TRIPLE", "")
arches = ["arm64", "x86_64"] if target.startswith("universal") else ["x86_64"] if target.startswith("x86_64") else ["arm64"] if target.startswith("aarch64") else [os.uname().machine]
binaries = []
for arch in arches:
    binary = source / "build" / ("Thumbnail-" + arch)
    subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-emit-executable", "-application-extension", "-O",
                    "-module-name", "AlbedoThumbnail", "-sdk", sdk, "-target", arch + "-apple-macos12.0",
                    "-framework", "AppKit", "-framework", "QuickLookThumbnailing", "-framework", "WebKit",
                    "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
                    str(source / "ThumbnailProvider.swift"), "-o", str(binary)], check=True)
    binaries.append(str(binary))
subprocess.run(["xcrun", "lipo", "-create", *binaries, "-output", str(bundle / "MacOS/AlbedoThumbnail")], check=True)
# Sign the nested extension before Tauri signs the containing application.
# Without a Developer ID this is a local ad-hoc build, not notarized distribution.
identity = os.environ.get("APPLE_SIGNING_IDENTITY") or "-"
subprocess.run(["codesign", "--force", "--sign", identity, "--options", "runtime", "--entitlements",
                str(source / "Thumbnail.entitlements"), str(bundle.parent)], check=True)
