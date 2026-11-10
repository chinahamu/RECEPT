import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { createWorkspaceApi } from './server/api';

function receptWorkspace(): Plugin {
  return {
    name: 'recept-workspace',
    configureServer(server) {
      const api = createWorkspaceApi();
      server.middlewares.use(api.middleware);
      server.httpServer?.once('close', api.close);
    },
    configurePreviewServer(server) {
      const api = createWorkspaceApi();
      server.middlewares.use(api.middleware);
      server.httpServer.once('close', api.close);
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss(), receptWorkspace()],
  server: {
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.sqlite3*'] },
  },
  preview: { host: '127.0.0.1' },
});
