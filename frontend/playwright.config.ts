import { defineConfig, devices } from "@playwright/test";

const agentPort = Number(process.env.FLOWBOARD_E2E_AGENT_PORT ?? "8199");
const frontendPort = Number(process.env.FLOWBOARD_E2E_FRONTEND_PORT ?? "5199");
const extensionWsPort = Number(process.env.FLOWBOARD_E2E_EXT_WS_PORT ?? "9299");
const agentUrl = `http://127.0.0.1:${agentPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const storageDir = process.env.FLOWBOARD_E2E_STORAGE ?? "/tmp/flowboard-e2e-storage";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ["list"],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL: frontendUrl,
    viewport: { width: 1440, height: 980 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: [
        "env",
        "PYTHONPATH=../agent",
        `FLOWBOARD_HTTP_PORT=${agentPort}`,
        `FLOWBOARD_EXT_WS_PORT=${extensionWsPort}`,
        `FLOWBOARD_STORAGE=${storageDir}`,
        "../agent/.venv/bin/uvicorn",
        "flowboard.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(agentPort),
      ].join(" "),
      url: `${agentUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: [
        "env",
        `FLOWBOARD_AGENT_URL=${agentUrl}`,
        `FLOWBOARD_FRONTEND_PORT=${frontendPort}`,
        "npm",
        "run",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(frontendPort),
      ].join(" "),
      url: frontendUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
  ],
});
