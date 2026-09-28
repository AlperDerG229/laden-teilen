// Vitest config for the bridge only (`npm run test:bridge`); the root config covers src/.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['bridge/**/*.test.ts'],
    environment: 'node',
  },
})
