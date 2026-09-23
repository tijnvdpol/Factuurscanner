import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "supabase/tests/**/*.test.ts"],
    // De databasetests starten een complete Postgres (PGlite) en draaien alle migraties.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
