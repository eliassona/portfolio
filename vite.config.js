import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,   // exposes on 0.0.0.0 — accessible from any device on your local network
    port: 5173,
  },
})
