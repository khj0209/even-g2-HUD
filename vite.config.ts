import { defineConfig } from 'vite';

// Relative base so the build works when packed into an .ehpk and loaded from a file-like origin.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
});
