import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static, client-only build — deployable to any static host. No server, no backend.
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Vite 8's watcher follows symlinked directories. devenv/direnv state
      // dirs are symlink portals into the nix store (.devenv/profile,
      // .direnv/flake-inputs/*), and a profile is a symlink forest — walking
      // it revisits shared closures through every link edge, millions of
      // paths, until the dev server exhausts the JS heap.
      ignored: ["**/.devenv/**", "**/.direnv/**"],
    },
  },
  build: {
    target: "es2022",
    // The bundle is a first-impression marketing surface; surface size regressions loudly.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split rarely-changing vendor code into its own long-cache chunk,
        // separate from app code and the lazy-loaded simulator/decimal.js chunk.
        // Rolldown's codeSplitting groups replace rollup's object-form
        // manualChunks; dependencies of matched modules are included
        // recursively by default.
        codeSplitting: {
          groups: [
            { name: "react", test: /\/node_modules\/(?:react|react-dom)\// },
            { name: "codemirror", test: /\/node_modules\/@codemirror\// },
          ],
        },
      },
    },
  },
});
