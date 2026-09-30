import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Served from GitHub Pages at https://lyvoralper.github.io/laden-teilen/ (hash routing).
export default defineConfig({
  base: '/laden-teilen/',
  plugins: [react()],
})
