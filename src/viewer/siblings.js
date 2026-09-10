import { LoadingManager } from "three";

/** Relative sidecars under Tauri's flattened asset URLs on all desktops. */
export function siblingManager(url, resolveSibling) {
  const manager = new LoadingManager();
  if (!resolveSibling) return manager;
  manager.setURLModifier((requested) => {
    if (!requested || requested === url || /^(blob|data):/i.test(requested)) return requested;
    const m = /^(?:https?:\/\/asset\.localhost|asset:\/\/localhost)\/(.*)$/i.exec(requested);
    if (!m) return requested;
    let rel;
    try { rel = decodeURIComponent(m[1]); } catch { return requested; }
    if (/^[a-z]:[\\/]/i.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) return requested;
    return resolveSibling(rel.split(/[?#]/)[0]) || requested;
  });
  return manager;
}
