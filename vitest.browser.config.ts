import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/**
 * Browser smoke tests (real Chromium via Playwright). The flake devShell sets
 * PLAYWRIGHT_BROWSERS_PATH to the nixpkgs playwright-browsers bundle, so
 * Playwright's normal registry lookup finds a browser that runs on NixOS too.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["**/*.browser.test.{ts,tsx}"],
    // Same trap vitest.config.ts guards against: .direnv/flake-inputs holds a
    // store snapshot of this repo, and the include glob would collect every
    // browser suite a second time from frozen sources.
    exclude: ["**/node_modules/**", "**/.direnv/**"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          args: ["--no-sandbox"],
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
