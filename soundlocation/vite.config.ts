import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    basicSsl(),
  ],
  server: {
    host: true,
    proxy: {
      '/api/elevation': {
        target: 'https://api.open-meteo.com/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/elevation/, '/elevation'),
      },
    },
  },
})
