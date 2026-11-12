import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API and terminal sockets live on the server (7430); Vite only serves the UI in dev.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7430',
      '/ws': { target: 'ws://127.0.0.1:7430', ws: true },
    },
  },
})
