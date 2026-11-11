import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditAccess } from './accessAudit';
import { z } from 'zod';
import { hasStaffRole, type Staff, type StaffRole } from '../src/types/staff';
import type { Workspace, WorkspaceAction } from '../src/types/workspace';
import { sessionCookie, staffSessions } from './staffSessions';
import { isLocalRequest, isSameOriginApiRequest, protectedResponseHeaders } from './browserProtection';
import { requestSchema } from './validation';
import { openWorkspace } from './workspace';
import { WorkspaceError } from './errors';
import { masterFileParams } from './officialMasters';
import { MAX_BODY_BYTES as integrationMaxBytes } from '../integration/recept-v1/contract.mjs';
import { MASTER_MAX_BYTES } from '../src/data/officialMasters';

const maxBodyBytes = 4 * 1024 * 1024;
const credentialsSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  password: z.string().min(1).max(256),
});

const integrationId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const integrationToken = /^[A-Za-z0-9._~+\/=-]{1,512}$/;
const matchSchema = z.strictObject({ patientId: z.string().min(1).max(100), chartNumber: z.string().min(1).max(100) });

function integrationSource(req: IncomingMessage) {
  const { RECEPT_DENCAL_FACILITY_ID: facilityId, RECEPT_DENCAL_SENDER_ID: senderId, RECEPT_DENCAL_TOKEN: token } = process.env;
  const authorization = /^Bearer ([A-Za-z0-9._~+\/=-]{1,512})$/.exec(req.headers.authorization ?? '')?.[1];
  if (!facilityId || !/^[0-9]{10}$/.test(facilityId) || !senderId || !integrationId.test(senderId) ||
      !token || !integrationToken.test(token) || !authorization ||
      !timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(authorization).digest())) {
    throw new WorkspaceError(401, 'authentication_required');
  }
  return { facilityId, senderId };
}

const actionRoles: Record<WorkspaceAction['type'], StaffRole> = {
  register: 'reception', update: 'physician', fix: 'physician', batchFix: 'physician',
  finalize: 'physician', toggleOffline: 'admin', reset: 'admin', exportCsv: 'admin', snapshot: 'admin',
};

function visibleWorkspace(workspace: Workspace, staff: Staff): Workspace {
  return hasStaffRole(staff, 'admin') ? workspace : { ...workspace, activity: [], dataExportsEnabled: false };
}


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

async function readJson(req: IncomingMessage, limit: number) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new WorkspaceError(415, 'JSON形式で送信してください。');
  }
  const bytes = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new WorkspaceError(400, 'JSONを読み込めません。');
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...protectedResponseHeaders,
  });
  res.end(JSON.stringify(body));
}

type VerifiedSession = { staff: Staff; sessionId: string; loginAt: string; expiresAt: number };

export function createWorkspaceApi(
  open = openWorkspace,
  resolveVerifiedSession?: (req: IncomingMessage) => VerifiedSession | null | Promise<VerifiedSession | null>,
) {
  let store: ReturnType<typeof openWorkspace> | undefined;
  const sessions = staffSessions();
  let failedLogins = 0;
  let loginWindowEnds = 0;
  return {
    close() {
      sessions.clear();
      store?.close();
      store = undefined;
    },
    middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
      const path = req.url?.split('?')[0];
      const isSession = path === '/api/session' || path === '/api/login' || path === '/api/logout';
      const machine = path?.startsWith('/api/integration/v1/') ?? false;
      const inboxPath = /^\/api\/integration\/inbox(?:\/([0-9]+)(\/match)?)?$/.exec(path ?? '');
      if (!machine && !inboxPath && !isSession && path !== '/api/official-masters' && path !== '/api/workspace' && path !== '/api/claim-preview' &&
          path !== '/api/claim-records') return next();

      const access: AuditAccess = {
        requestId: randomUUID(),
        requestedAt: new Date().toISOString(),
        actor: { kind: 'anonymous' },
        resource: machine || inboxPath ? 'dencal-inbox' : isSession ? 'session' : path === '/api/official-masters' ? 'official-masters'
          : path === '/api/workspace' ? 'workspace' : path === '/api/claim-records' ? 'claim-records' : 'claim-preview',
        operation: req.method === 'GET' ? 'read' : req.method === 'POST' ? 'write' : 'unsupported-method',
      };

      void (async () => {
        if (machine) {
          if (!isLocalRequest(req) || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers.cookie !== undefined) {
            throw new WorkspaceError(403, 'source_scope_mismatch');
          }
          const source = integrationSource(req);
          access.actor = { kind: 'integration', ...source };
          store ??= open();
          if (path === '/api/integration/v1/encounters') {
            access.operation = 'receive-dencal';
            if (req.method !== 'POST') {
              res.setHeader('Allow', 'POST');
              throw new WorkspaceError(405, 'invalid_payload');
            }
            if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
              throw new WorkspaceError(415, 'unsupported_media_type');
            }
            const bytes = await readBody(req, integrationMaxBytes);
            const result = store.receiveDencal(bytes, source, access);
            sendJson(res, result.httpStatus, result.body);
            return;
          }

          const encoded = /^\/api\/integration\/v1\/receipts\/([^/]+)$/.exec(path ?? '')?.[1];
          let id = '';
          try { id = decodeURIComponent(encoded ?? ''); } catch { /* Treat malformed paths as absent. */ }
          if (!integrationId.test(id)) throw new WorkspaceError(404, 'receipt_not_found');
          access.operation = 'read-dencal-receipt';
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            throw new WorkspaceError(405, 'invalid_payload');
          }
          const result = store.readDencalReceipt(source, id, access);
          sendJson(res, result ? 200 : 404, result ?? { error: 'receipt_not_found' });
          return;
        }

        if (!isSameOriginApiRequest(req)) {
          throw new WorkspaceError(403, 'このデモAPIは同じPCから利用してください。');
        }

        store ??= open();
        const currentStore = store;
        const identify = async () => {
          const session = resolveVerifiedSession ? await resolveVerifiedSession(req) : sessions.get(req, currentStore.accounts.active);
          const displayedSession = req.headers['x-recept-session'];
          if (displayedSession !== undefined && displayedSession !== session?.sessionId) {
            throw new WorkspaceError(401, 'ログイン中の職員が変わりました。もう一度ログインしてください。');
          }
          if (session) access.actor = { kind: 'authenticated', userId: session.staff.id, loginAt: session.loginAt };
          return session;
        };
        const requireRole = async (minimum: StaffRole) => {
          const session = await identify();
          if (!session) throw new WorkspaceError(401, '職員IDでログインしてください。');
          if (!hasStaffRole(session.staff, minimum)) throw new WorkspaceError(403, 'この操作を行う職種の権限がありません。');
          return session;
        };

        if (isSession) {
          access.operation = path === '/api/login' ? 'login' : path === '/api/logout' ? 'logout' : 'session';
          const method = path === '/api/session' ? 'GET' : 'POST';
          if (req.method !== method) {
            res.setHeader('Allow', method);
            throw new WorkspaceError(405, '未対応の操作です。');
          }
          if (path === '/api/login') {
            const input = credentialsSchema.safeParse(await readJson(req, 4096));
            if (!input.success) throw new WorkspaceError(400, '職員IDとパスワードを入力してください。');
            const now = Date.now();
            if (now >= loginWindowEnds) {
              failedLogins = 0;
              loginWindowEnds = now + 60_000;
            }
            if (failedLogins >= 10) {
              res.setHeader('Retry-After', String(Math.ceil((loginWindowEnds - now) / 1000)));
              throw new WorkspaceError(429, 'ログイン試行回数の上限です。しばらくしてから再試行してください。');
            }
            const account = currentStore.accounts.authenticate(input.data.id, input.data.password);
            if (!account) {
              failedLogins++;
              throw new WorkspaceError(401, '職員IDまたはパスワードが正しくありません。');
            }
            access.actor = { kind: 'authenticated', userId: account.id, loginAt: new Date(now).toISOString() };
            currentStore.recordAccess(access, 200);
            const { token, sessionId, expiresAt } = sessions.create(account, req, now);
            res.setHeader('Set-Cookie', sessionCookie(req, token));
            sendJson(res, 200, { staff: { id: account.id, role: account.role }, sessionId, expiresAt });
          } else if (path === '/api/logout') {
            await identify();
            sessions.revoke(req);
            res.setHeader('Set-Cookie', sessionCookie(req));
            currentStore.recordAccess(access, 200);
            sendJson(res, 200, { staff: null });
          } else {
            const session = await requireRole('reception');
            sendJson(res, 200, { staff: session.staff, sessionId: session.sessionId, expiresAt: session.expiresAt });
          }
          return;
        }

        const { staff } = await requireRole('reception');
        if (inboxPath) {
          const [, id, matching] = inboxPath;
          const method = matching ? 'POST' : 'GET';
          if (req.method !== method) {
            res.setHeader('Allow', method);
            throw new WorkspaceError(405, '未対応の操作です。');
          }
          const seq = id ? Number(id) : null;
          if (seq !== null && (!Number.isSafeInteger(seq) || seq < 1)) throw new WorkspaceError(400, '受信番号が正しくありません。');
          if (seq === null) {
            const before = new URLSearchParams(req.url?.split('?')[1]).get('before');
            const cursor = before === null ? null : Number(before);
            if (before !== null && cursor !== null && (!/^[0-9]+$/.test(before) || !Number.isSafeInteger(cursor) || cursor < 1)) {
              throw new WorkspaceError(400, '受信一覧の照会条件が正しくありません。');
            }
            access.operation = 'list-dencal-inbox';
            sendJson(res, 200, currentStore.listDencal(cursor, access));
          } else if (matching) {
            access.operation = 'match-dencal-patient';
            const input = matchSchema.safeParse(await readJson(req, 4096));
            if (!input.success) throw new WorkspaceError(400, '紐付け先を確認してください。');
            await requireRole('reception');
            sendJson(res, 200, currentStore.matchDencal(seq, input.data.patientId, input.data.chartNumber, access));
          } else {
            access.operation = 'read-dencal-inbox';
            sendJson(res, 200, currentStore.readDencal(seq, access));
          }
          return;
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
            access.operation = kind ? 'search-clinical-master' : importId === null ? 'list-masters' : 'search-master';
            if (!kind) await requireRole('admin');
            sendJson(res, 200, currentStore.readMasters(kind, importId === null ? null : id, query, access));
          } else if (req.method === 'POST') {
            access.operation = 'import-master';
            await requireRole('admin');
            if (req.headers['content-type'] !== 'application/octet-stream') {
              throw new WorkspaceError(415, '解凍したマスターファイルを送信してください。');
            }
            const file = masterFileParams(params.get('filename') ?? '', params.get('publishedOn') ?? '');
            const bytes = await readBody(req, MASTER_MAX_BYTES);
            await requireRole('admin');
            sendJson(res, 200, currentStore.importMaster(file, bytes, access));
          } else {
            res.setHeader('Allow', 'GET, POST');
            throw new WorkspaceError(405, '未対応の操作です。');
          }
        } else if (access.resource === 'claim-records' && req.method === 'GET') {
          const params = new URLSearchParams(req.url?.split('?')[1]);
          const patientId = params.get('patientId');
          const id = params.get('id');
          const query = (params.get('q') ?? '').trim();
          const before = params.get('before');
          const exportMode = params.get('export');
          const validId = /^[A-Za-z0-9_-]{1,100}$/;
          if ((patientId !== null && !validId.test(patientId)) || (id !== null && !validId.test(id)) ||
              (patientId !== null && id !== null) || query.length > 100 ||
              (exportMode !== null && (exportMode !== '1' || id === null)) ||
              (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) ||
              ((patientId !== null || id !== null) && (query || before !== null))) {
            throw new WorkspaceError(400, '請求記録の照会条件が正しくありません。');
          }
          access.operation = patientId ? 'review-claim-draft' : id
            ? (exportMode ? 'export-claim-record' : 'read-claim-record') : 'list-claim-records';
          await requireRole(exportMode ? 'admin' : 'physician');
          if (patientId) {
            sendJson(res, 200, currentStore.previewConfirmation(patientId, access));
          } else if (id) {
            sendJson(res, 200, currentStore.readClaimRecord(id, access, exportMode === '1'));
          } else {
            sendJson(res, 200, currentStore.listClaimRecords(query, before === null ? null : Number(before), access));
          }
        } else if (req.method === 'GET') {
          if (path === '/api/claim-preview') {
            await requireRole('admin');
            sendJson(res, 200, currentStore.preview(access));
          } else {
            sendJson(res, 200, visibleWorkspace(currentStore.read(access), staff));
          }
        } else if (req.method === 'POST' && path === '/api/workspace') {
          const action = requestSchema.safeParse(await readJson(req, maxBodyBytes));
          if (!action.success) throw new WorkspaceError(400, '入力形式が正しくありません。');
          access.operation = action.data.action.type;
          const current = await requireRole(actionRoles[action.data.action.type]);
          const requested = action.data.action;
          if (requested.type === 'register' && (requested.patient.diagnoses.length || requested.patient.billingItems.length) &&
              !hasStaffRole(current.staff, 'physician')) {
            throw new WorkspaceError(403, '診療・算定情報の入力には医師以上の権限が必要です。');
          }
          const result = currentStore.apply(action.data, access);
          sendJson(res, 200, { ...result, workspace: visibleWorkspace(result.workspace, current.staff) });
        } else {
          res.setHeader('Allow', path === '/api/workspace' ? 'GET, POST' : 'GET');
          throw new WorkspaceError(405, '未対応の操作です。');
        }
      })().catch((error: unknown) => {
        const status = error instanceof WorkspaceError
          ? (machine && error.status >= 500 ? 503 : error.status)
          : machine ? 503 : 500;
        try {
          store ??= open();
          store.recordAccess(access, status);
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
            error: machine ? (status >= 500 ? 'temporarily_unavailable'
              : status === 413 ? 'payload_too_large' : error instanceof WorkspaceError ? error.message : 'invalid_payload')
              : error instanceof WorkspaceError ? error.message : 'SQLiteの処理に失敗しました。DBの設定と空き容量を確認してください。',
          });
        }
      });
    },
  };
}
