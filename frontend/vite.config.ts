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
  build: { chunkSizeWarningLimit: 6000 },
});
