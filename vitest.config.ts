import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    // Vitest stubs CSS imports to '' unless the file is listed here, which
    // also swallows `?raw` imports. The bundled plugin catalog is plain CSS
    // read as text, so let Vite serve it for real; app CSS stays stubbed.
    css: { include: [/src\/features\/plugins\/catalog\/.*\.css(?:\?raw)?$/] },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/tests/', '**/*.d.ts', '**/*.config.*', '**/mockData.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@locales': path.resolve(__dirname, './src/locales'),
      '@/core': path.resolve(__dirname, './src/core'),
      '@/features': path.resolve(__dirname, './src/features'),
      'wavedrom/render-any': path.resolve(__dirname, './node_modules/wavedrom/lib/render-any.js'),
    },
  },
});
