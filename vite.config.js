import { defineConfig } from "vite";

// Tauri drives the dev server; keep the port fixed and fail loudly if taken.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
