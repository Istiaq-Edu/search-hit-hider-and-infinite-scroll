import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Node 25's global localStorage is a method-less stub that shadows jsdom's
    // working one, which silently disabled the whole `_shh_cache` pre-paint
    // layer under test. See vitest.setup.ts for the measurement and the fix.
    setupFiles: ["./vitest.setup.ts"],
  },
});
