import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build works both at the domain root and under a
  // sub-path like GitHub Pages' /<repo>/.
  base: "./",
});
