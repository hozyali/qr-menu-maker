import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in the real Workers runtime with a real, temporary, local D1 database.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
          // Test values only. The Turnstile service itself is replaced in the tests.
          TURNSTILE_SITE_KEY: "test-site-key",
          TURNSTILE_SECRET_KEY: "test-secret-key",
          TURNSTILE_HOSTNAME: "app.tomatofry.com",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
