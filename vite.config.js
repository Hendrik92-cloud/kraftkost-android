import { defineConfig } from 'vite';
import { nativeHash } from './scripts/native-hash.mjs';

export default defineConfig({
  base: './',
  define: {
    __BUILD__: JSON.stringify(Number(process.env.BUILD_NUMBER) || 0),
    __NATIVE__: JSON.stringify(nativeHash())
  },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 1500 }
});
