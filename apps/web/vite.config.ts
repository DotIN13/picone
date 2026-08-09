import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const SERVER = process.env.PICONE_SERVER ?? "http://127.0.0.1:4319";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // Two copies of solid-js would each own their own reactive graph.
  resolve: { dedupe: ["solid-js"] },
  server: {
    port: 4318,
    strictPort: true,
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true },
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    sourcemap: true,
  },
});
