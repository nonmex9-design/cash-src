import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // make sure jsx is handled
  esbuild: { loader: 'jsx', include: /\.jsx?$/ },
  optimizeDeps: { esbuildOptions: { loader: { '.js': 'jsx', '.jsx': 'jsx' } } }
});