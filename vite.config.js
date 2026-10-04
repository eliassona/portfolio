import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Optional env vars (defaults = same behaviour as plain `npm start`):
//   PORT           frontend port            (default 5173)
//   API_PORT       backend/server.js port   (default 3001)
//   HOLDINGS_FILE  holdings file to use     (default ./holdings.json)
const PORT     = Number(process.env.PORT) || 5173
const API_PORT = Number(process.env.API_PORT) || 3001

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@holdings': path.resolve(process.env.HOLDINGS_FILE || 'holdings.json'),
    },
  },
  define: {
    __API_PORT__: JSON.stringify(API_PORT),
  },
  server: {
    host: true,
    port: PORT,
    strictPort: !!process.env.PORT, // fail instead of silently picking another port when one is requested
    allowedHosts: "all",
  },
})
