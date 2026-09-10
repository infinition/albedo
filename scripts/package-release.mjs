import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const platform = process.platform;
const target = platform === "darwin" ? "src-tauri/target/universal-apple-darwin/release" : "src-tauri/target/release";
mkdirSync("release-assets", { recursive: true });
if (platform === "win32") {
  const dll = readFileSync("shell-thumbnails/target/release/albedo_thumbnails.dll");
  const exe = readFileSync(join(target, "albedo.exe"));
  const offset = Math.floor(dll.length / 2);
  if (exe.indexOf(dll.subarray(offset, offset + 64)) < 0) throw new Error("Thumbnail provider missing from the executable");
  writeFileSync("release-assets/Albedo.exe", exe);
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath release-assets/Albedo.exe -DestinationPath release-assets/Albedo-portable-win-x64.zip -Force"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ZIP packaging failed");
}
let packages = 0;
for (const type of platform === "win32" ? ["nsis"] : platform === "darwin" ? ["dmg"] : ["deb", "rpm", "appimage"]) {
  const folder = join(target, "bundle", type);
  for (const name of readdirSync(folder)) {
    if (!/\.(exe|dmg|deb|rpm|AppImage)$/.test(name)) continue;
    cpSync(join(folder, name), join("release-assets", name)); packages++;
  }
}
if (!packages) throw new Error("No native packages produced");
