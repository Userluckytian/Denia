import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': loadEnv(mode, '.', 'DENIA_').DENIA_API_URL || 'http://127.0.0.1:3601',
    },
  },
  build: {
    outDir: 'dist',
  },
}))
