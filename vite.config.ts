import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import { createWorkspaceApi } from './server/api';
import { isLocalRequest, protectedResponseHeaders } from './server/browserProtection';

function receptWorkspace(): Plugin {
  function protectLocalApp(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (isLocalRequest(req)) return next();
    res.writeHead(403, { ...protectedResponseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RECEPTの開発画面は同じPCから利用してください。');
  }

  return {
    name: 'recept-workspace',
    configResolved({ server, preview }) {
      const loopback = ['127.0.0.1', 'localhost', '::1'];
      if ([server.host, preview.host].some((host) => typeof host !== 'string' || !loopback.includes(host))) {
        throw new Error('RECEPTの開発サーバーとプレビューはループバックアドレスで起動してください。');
      }
    },
    configureServer(server) {
      const api = createWorkspaceApi();
      server.middlewares.use(api.middleware);
      server.middlewares.use(protectLocalApp);
      server.httpServer?.once('close', api.close);
    },
    configurePreviewServer(server) {
      const api = createWorkspaceApi();
      server.middlewares.use(api.middleware);
      server.middlewares.use(protectLocalApp);
      server.httpServer.once('close', api.close);
    },
  };
}

const localServer = {
  host: '127.0.0.1',
  cors: false,
  headers: protectedResponseHeaders,
};

const runtimeData = `${normalizePath(resolve('data'))}/**`;
export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss(), receptWorkspace()],
  server: {
    ...localServer,
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.sqlite3*', runtimeData,
        '**/recept-demo-claims.csv', '**/recept-demo-claim-*.json', '**/recept-demo-snapshot-*.json',
      ],
    },
    watch: { ignored: [runtimeData, '**/*.sqlite3*'] },
  },
  preview: localServer,
});
