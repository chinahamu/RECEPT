import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { StaffRole } from '../src/types/staff';
import { WorkspaceError } from './errors';

const dummySalt = Buffer.alloc(16);
const dummyHash = Buffer.alloc(32);

function passwordHash(password: string, salt: Uint8Array) {
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
}

export function staffAccounts(db: DatabaseSync) {
  return {
    authenticate(id: string, password: string) {
      const row = db.prepare(`SELECT role, salt, password_hash, active, credential_version FROM staff_accounts WHERE id = ?`).get(id) as
        { role: StaffRole; salt: Uint8Array; password_hash: Uint8Array; active: number; credential_version: number } | undefined;
      const matches = timingSafeEqual(passwordHash(password, row?.salt ?? dummySalt), row?.password_hash ?? dummyHash);
      return matches && row?.active === 1 ? { id, role: row.role, version: row.credential_version } : null;
    },
    active(id: string, version: number) {
      const row = db.prepare('SELECT role FROM staff_accounts WHERE id = ? AND active = 1 AND credential_version = ?')
        .get(id, version) as { role: StaffRole } | undefined;
      return row ? { id, role: row.role } : null;
    },
    create(id: string, role: StaffRole) {
      const password = randomBytes(18).toString('base64url');
      const salt = randomBytes(16);
      const result = db.prepare('INSERT INTO staff_accounts(id, role, salt, password_hash) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(id, role, salt, passwordHash(password, salt));
      if (!result.changes) throw new WorkspaceError(409, '同じ職員IDが既に存在します。');
      return password;
    },
    reset(id: string) {
      const password = randomBytes(18).toString('base64url');
      const salt = randomBytes(16);
      const result = db.prepare(`UPDATE staff_accounts SET salt = ?, password_hash = ?, active = 1,
        credential_version = credential_version + 1 WHERE id = ?`).run(salt, passwordHash(password, salt), id);
      if (!result.changes) throw new WorkspaceError(404, '職員IDが見つかりません。');
      return password;
    },
    disable(id: string) {
      const result = db.prepare('UPDATE staff_accounts SET active = 0, credential_version = credential_version + 1 WHERE id = ?').run(id);
      if (!result.changes) throw new WorkspaceError(404, '職員IDが見つかりません。');
    },
  };
}
