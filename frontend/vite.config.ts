import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.MSTAR_POST_BACKEND ?? "http://localhost:5045";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: backend, ws: true },
    },
  },
  // The big libraries get their own files with stable names, loaded only by the tabs that use them
  // (Plots / Results / Viewer: plotly, Viewer and CAD preview: three, Theory: katex); the entry
  // chunk (dashboard, Cases, Files, Jobs, GPUs) must not import any of them. plotly alone is ~4.6 MB.
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // the CommonJS interop helper is shared with React: on its own, or Rollup puts it into
          // the plotly chunk and the entry chunk then imports plotly
          if (id.includes("commonjsHelpers")) return "cjs";
          if (id.includes("node_modules/plotly.js")) return "plotly";
          if (id.includes("node_modules/three/")) return "three";
          if (id.includes("node_modules/katex/")) return "katex";
          return undefined;
        },
      },
    },
  },
});
