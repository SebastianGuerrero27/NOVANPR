import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    // En Docker sobre Windows los cambios del volumen montado no generan eventos del sistema de
    // archivos: sin sondeo, Vite sigue sirviendo la versión anterior de cada módulo.
    watch: { usePolling: true, interval: 300 }
  }
});
