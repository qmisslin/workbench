import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const rootDirectory =
  dirname(
    fileURLToPath(
      import.meta.url
    )
  );

export default defineConfig({
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,

    rollupOptions: {
      input: {
        main: resolve(
          rootDirectory,
          'index.html'
        ),
        trackingDebug: resolve(
          rootDirectory,
          'tracking-debug.html'
        )
      }
    }
  }
});