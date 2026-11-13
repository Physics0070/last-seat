import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the API runs separately; its port comes from the repository's .env, the file the server reads.
// Parsed by hand on purpose: Vite's loadEnv would also adopt NODE_ENV=development from that file and
// quietly ship React's development build from `vite build`.
const envFile = new URL('../.env', import.meta.url)
const { PORT } = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}

export default defineConfig({
  plugins: [react()],
  server: { proxy: PORT ? { '/api': `http://127.0.0.1:${PORT}` } : undefined },
})
