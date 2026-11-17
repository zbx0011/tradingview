import { defineConfig } from 'vite'

// Phone build (scripts/build-apk.ps1): only the bar-by-bar practice page, no desktop data folder.
export default defineConfig({
  base: './',
  publicDir: false,
  build: { outDir: 'dist-mobile', emptyOutDir: true, rollupOptions: { input: 'mobile.html' } },
})
