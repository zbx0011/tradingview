import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves project sites below /<repository-name>/. The workflow
  // supplies this value while local development keeps the normal root path.
  base: process.env.VITE_BASE_PATH ?? '/',
  build: { chunkSizeWarningLimit: 600 },
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
