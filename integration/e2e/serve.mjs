import { createServer } from 'node:http';
import { createWorkspaceApi } from '../../server/api.ts';
import { openWorkspace } from '../../server/workspace.ts';

// This entry point belongs to the integration test and requires an IPC parent.
const [filename, mode] = process.argv.slice(2);
if (!process.send || !filename || process.env.RECEPT_DB !== filename ||
    !['initialize', 'restart'].includes(mode)) {
  throw new Error('Run the paired integration test to start this fixture.');
}

let passwords;
if (mode === 'initialize') {
  const store = openWorkspace(filename);
  try {
    passwords = {
      'e2e-admin': store.accounts.create('e2e-admin', 'admin'),
      'e2e-reception': store.accounts.create('e2e-reception', 'reception'),
    };
  } finally {
    store.close();
  }
}

const api = createWorkspaceApi();
const server = createServer((req, res) => api.middleware(req, res, () => res.writeHead(404).end()));
server.once('close', () => api.close());
process.once('disconnect', () => server.close());
server.listen(0, '127.0.0.1', () => {
  process.send({ origin: `http://127.0.0.1:${server.address().port}`, passwords });
});
