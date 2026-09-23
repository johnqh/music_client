import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

/**
 * A single bundled `dist/index.js`, matching entity_pages' pattern rather
 * than the many-file `tsc` output every other `music_*` package still uses —
 * see that family's own CLAUDE.md for why the two conventions coexist. `tsc`
 * (plain `tsconfig.json`, `noEmit: true`) is still the type-check gate; this
 * is the only thing that actually emits `dist/`. Separate from
 * `vitest.config.ts`, which vitest picks over this file on its own, so tests
 * are unaffected by the build-only plugins here.
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        '@sudobility/music_types',
        '@sudobility/di',
        '@sudobility/types',
        '@tanstack/react-query',
      ],
      output: {
        exports: 'named',
      },
    },
  },
});
