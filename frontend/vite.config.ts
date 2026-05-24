import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const agentUrl = process.env.FLOWBOARD_AGENT_URL ?? "http://localhost:8101";
const agentWsUrl = agentUrl.replace(/^http/, "ws");
const devPort = Number(process.env.FLOWBOARD_FRONTEND_PORT ?? "5173");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: devPort,
    proxy: {
      "/api": agentUrl,
      "/media": agentUrl,
      "/ws": {
        target: agentWsUrl,
        ws: true,
      },
    },
  },
});
