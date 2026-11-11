import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Staff } from '../src/types/staff';

const cookieName = 'recept_session';
const duration = 30 * 60 * 1000;
type Session = { id: string; version: number; sessionId: string; loginAt: string; expiresAt: number };

function digest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function requestKey(req: IncomingMessage) {
  const token = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : '';
}

export function sessionCookie(req: IncomingMessage, token = '') {
  const secure = 'encrypted' in req.socket && req.socket.encrypted ? '; Secure' : '';
  return `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${token ? duration / 1000 : 0}${secure}`;
}

export function staffSessions(now = Date.now) {
  const sessions = new Map<string, Session>();
  return {
    create(account: Staff & { version: number }, req: IncomingMessage, current = now()) {
      const old = requestKey(req);
      for (const [key, session] of sessions) {
        if (session.expiresAt <= current || session.id === account.id || key === old) sessions.delete(key);
      }
      const token = randomBytes(32).toString('base64url');
      const session = { id: account.id, version: account.version, sessionId: randomUUID(), loginAt: new Date(current).toISOString(), expiresAt: current + duration };
      sessions.set(digest(token), session);
      return { token, sessionId: session.sessionId, expiresAt: session.expiresAt };
    },
    get(req: IncomingMessage, active: (id: string, version: number) => Staff | null) {
      const key = requestKey(req);
      const session = sessions.get(key);
      if (!session) return null;
      const staff = session.expiresAt > now() ? active(session.id, session.version) : null;
      if (!staff) {
        sessions.delete(key);
        return null;
      }
      return { staff, sessionId: session.sessionId, loginAt: session.loginAt, expiresAt: session.expiresAt };
    },
    revoke(req: IncomingMessage) { sessions.delete(requestKey(req)); },
    clear() { sessions.clear(); },
  };
}
