import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Only the sidebar needs a DOM; the engine stays in plain node.
    environmentMatchGlobs: [["test/client/**", "jsdom"]],
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
