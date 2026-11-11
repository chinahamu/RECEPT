import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditAccess, AuditActor } from './accessAudit';
import { requestSchema } from './validation';
import { openWorkspace } from './workspace';
import { WorkspaceError } from './errors';
import { masterFileParams } from './officialMasters';
import { MASTER_MAX_BYTES } from '../src/data/officialMasters';

const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const maxBodyBytes = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new WorkspaceError(413, 'ファイルまたはデータの送信サイズが上限を超えました。');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readAction(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new WorkspaceError(415, 'JSON形式で送信してください。');
  }
  const bytes = await readBody(req, maxBodyBytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new WorkspaceError(400, 'JSONを読み込めません。');
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceError(400, '入力形式が正しくありません。');
  return parsed.data;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function createWorkspaceApi(
  open = openWorkspace,
  // Only a server-side authenticator may supply a verified actor.
  resolveActor: (req: IncomingMessage) => AuditActor | Promise<AuditActor> = () => ({ kind: 'anonymous' }),
) {
  let store: ReturnType<typeof openWorkspace> | undefined;
  return {
    close() {
      store?.close();
      store = undefined;
    },
    middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
      const path = req.url?.split('?')[0];
      if (path !== '/api/official-masters' && path !== '/api/workspace' && path !== '/api/claim-preview') return next();

      const access: AuditAccess = {
        requestId: randomUUID(),
        requestedAt: new Date().toISOString(),
        actor: { kind: 'anonymous' },
        resource: path === '/api/official-masters' ? 'official-masters'
          : path === '/api/workspace' ? 'workspace' : 'claim-preview',
        operation: req.method === 'GET' ? 'read' : req.method === 'POST' ? 'write' : 'unsupported-method',
      };

      void (async () => {
        const host = req.headers.host ?? '';
        const origin = req.headers.origin;
        if (!loopbackHost.test(host) || !loopbackAddresses.has(req.socket.remoteAddress ?? '') ||
            (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
          throw new WorkspaceError(403, 'このデモAPIは同じPCから利用してください。');
        }

        const actor = await resolveActor(req);
        if (actor.kind === 'authenticated') {
          access.actor = { kind: actor.kind, userId: actor.userId, loginAt: actor.loginAt };
        }
        if (access.resource === 'official-masters') {
          const params = new URLSearchParams(req.url?.split('?')[1]);
          if (req.method === 'GET') {
            const kind = params.get('clinical');
            const importId = params.get('id');
            const query = (params.get('q') ?? '').trim();
            const id = Number(importId);
            if (query.length > 200 || (kind !== null && kind !== 'b' && kind !== 's') ||
                (importId !== null && (!Number.isSafeInteger(id) || id < 1))) {
              throw new WorkspaceError(400, 'マスターの検索条件が正しくありません。');
            }
            store ??= open();
            access.operation = kind ? 'search-clinical-master' : importId === null ? 'list-masters' : 'search-master';
            sendJson(res, 200, store.readMasters(kind, importId === null ? null : id, query, access));
          } else if (req.method === 'POST') {
            access.operation = 'import-master';
            if (req.headers['content-type'] !== 'application/octet-stream') {
              throw new WorkspaceError(415, '解凍したマスターファイルを送信してください。');
            }
            const file = masterFileParams(params.get('filename') ?? '', params.get('publishedOn') ?? '');
            const bytes = await readBody(req, MASTER_MAX_BYTES);
            store ??= open();
            sendJson(res, 200, store.importMaster(file, bytes, access));
          } else {
            res.setHeader('Allow', 'GET, POST');
            throw new WorkspaceError(405, '未対応の操作です。');
          }
        } else if (req.method === 'GET') {
          store ??= open();
          sendJson(res, 200, path === '/api/claim-preview' ? store.preview(access) : store.read(access));
        } else if (req.method === 'POST' && path === '/api/workspace') {
          const action = await readAction(req);
          access.operation = action.action.type;
          store ??= open();
          sendJson(res, 200, store.apply(action, access));
        } else {
          res.setHeader('Allow', path === '/api/workspace' ? 'GET, POST' : 'GET');
          throw new WorkspaceError(405, '未対応の操作です。');
        }
      })().catch((error: unknown) => {
        const status = error instanceof WorkspaceError ? error.status : 500;
        try {
          store ??= open();
          store.recordFailure(access, status);
        } catch {
          console.error(JSON.stringify({
            event: 'access-audit-unavailable', requestId: access.requestId, at: new Date().toISOString(),
          }));
        }
        if (status === 401 || status === 403 || status >= 500) {
          console.error(JSON.stringify({
            event: 'access-audit-request-failed', requestId: access.requestId, status, at: new Date().toISOString(),
          }));
        }
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, status, {
            error: error instanceof WorkspaceError ? error.message : 'SQLiteの処理に失敗しました。DBの設定と空き容量を確認してください。',
          });
        }
      });
    },
  };
}
