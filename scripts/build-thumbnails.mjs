import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
if (process.platform === "linux") chmodSync("platform/linux/albedo-thumbnailer", 0o755);
const command = process.platform === "win32"
  ? ["cargo", "build", "--release", "--manifest-path", "shell-thumbnails/Cargo.toml"]
  : process.platform === "darwin" ? ["python3", "platform/macos/build.py"] : null;
if (command) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
