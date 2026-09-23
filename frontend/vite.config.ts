import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  //added
  optimizeDeps: {
    include: ['@deck.gl/react', '@deck.gl/core', 'react', 'react-dom'],
  },
})
