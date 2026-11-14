import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        home: resolve(rootDirectory, "index.html"),
        mapMatchV1: resolve(rootDirectory, "map-match-v1/index.html"),
        mapMatchApiV1: resolve(rootDirectory, "map-match-api-v1/index.html"),
        mapMatchOvertureV1: resolve(rootDirectory, "map-match-overture-v1/index.html"),
        mapMatchApiOvertureV1: resolve(
          rootDirectory,
          "map-match-api-overture-v1/index.html",
        ),
        runMapMatch: resolve(rootDirectory, "run-map-match/index.html"),
      },
    },
  },
  server: {
    strictPort: true,
  },
});
