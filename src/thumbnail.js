import { Viewer } from "./viewer/viewer.js";
import { thumbnail } from "./viewer/thumbnail.js";

// This page has no Tauri IPC or editor UI. Native hosts expose only the assets
// and model granted to this request, and accept a single PNG or error message.
const reply = (value) => window.webkit.messageHandlers.thumbnail.postMessage(JSON.stringify(value));
try {
  const response = await fetch("/job.json");
  if (!response.ok) throw new Error("Missing thumbnail job");
  const job = await response.json();
  const viewer = new Viewer(document.getElementById("canvas"));
  reply({ data: await thumbnail(viewer, job) });
} catch (error) {
  reply({ error: String(error?.message || error) });
}
