import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'browser',
  plugins: [react()],
  server: { port: 5173 },
})
