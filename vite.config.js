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
    rollupOptions: {
      output: {
        /**
         * Keep the engine and its optional readers apart.
         *
         * three's core is needed to draw anything, so it is paid at startup and
         * there is no arguing with that. Its example loaders are not: each one
         * matters only when a file of that format turns up. Left alone, a
         * loader used by two lazy chunks gets hoisted into the shared one that
         * also holds the core, and so quietly becomes a startup cost again.
         * This pins the boundary: the core in its own chunk, every example in
         * a chunk of its own, fetched when its format is.
         */
        manualChunks(id) {
          if (!id.includes("node_modules/three/")) return;
          if (id.includes("/examples/")) {
            const name = id.split("/").pop().replace(/\.\w+$/, "");
            return `three-${name}`;
          }
          return "three";
        },
      },
    },
  },
});
