import { defineConfig } from 'vite';

export default defineConfig({
  // host:true binds to all interfaces so another device on the same Wi-Fi can
  // load the page. The client derives its websocket URL from location.hostname,
  // so opening http://<lan-ip>:5178/?online=1 automatically points the socket at
  // ws://<lan-ip>:8099 — no config needed on the second device.
  server: { port: 5178, host: true },
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
