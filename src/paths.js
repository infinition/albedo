/** Resolve model sidecars without turning POSIX paths into Windows paths. */
export function resolveSiblingPath(modelPath, relative) {
  const windows = /^[a-z]:[\\/]/i.test(modelPath) || modelPath.startsWith("\\\\");
  const slash = windows ? "\\" : "/";
  const prefix = modelPath.startsWith("\\\\") ? "\\\\" : modelPath.startsWith("/") ? "/" : "";
  const parts = modelPath.split(windows ? /[\\/]/ : /\//).filter(Boolean);
  parts.pop();
  const floor = windows ? (prefix ? 2 : 1) : 0;
  for (const segment of relative.split(/[\\/]/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (parts.length > floor) parts.pop(); }
    else parts.push(segment);
  }
  return prefix + parts.join(slash);
}
