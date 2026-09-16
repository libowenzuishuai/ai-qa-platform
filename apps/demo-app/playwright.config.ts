import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-golden",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://127.0.0.1:7400",
    headless: true,
  },
  reporter: [["list"]],
});
