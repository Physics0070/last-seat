import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// In development the API runs separately; its port comes from the repository's .env, the same file the server reads.
export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, '..', '')
  return {
    plugins: [react()],
    server: { proxy: PORT ? { '/api': `http://127.0.0.1:${PORT}` } : undefined },
  }
})
