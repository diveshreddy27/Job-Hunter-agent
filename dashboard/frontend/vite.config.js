import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
    // On WSL with the project on the Windows mount (/mnt/c), native file
    // events don't fire — without polling, HMR silently misses edits.
    watch: { usePolling: true, interval: 300 },
  },
})
