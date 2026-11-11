import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, createReadStream, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyDencalInbox } from './dencalInbox';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { verifyAccessAudit } from './accessAudit';
import { verifyClaimRecords } from './claimRecords';
import {
  databaseFileSuffixes, isPrivateFile, protectedDatabasePath, protectedDirectory, RECEPT_APPLICATION_ID, RECEPT_SCHEMA_VERSIONS,
} from './databaseFiles';

const databaseName = 'recept.sqlite3';
const manifestName = 'manifest.json';
const manifestSchema = z.object({
  formatVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  databaseSchemaVersion: z.number().int().refine((version) => RECEPT_SCHEMA_VERSIONS.includes(version)),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
type Manifest = z.infer<typeof manifestSchema>;

function syncPath(path: string, flags = 'r+') {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  try {
    syncPath(path, 'r');
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function fingerprint(path: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function assertNoCompanionFiles(path: string) {
  for (const suffix of databaseFileSuffixes.slice(1)) {
    if (lstatSync(path + suffix, { throwIfNoEntry: false })) {
      throw new Error('DBの関連ファイルが残っています。別の復元先、または単体のバックアップ世代を指定してください。');
    }
  }
}

function readDatabaseVersion(db: DatabaseSync) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (db.prepare('PRAGMA application_id').get()?.application_id !== RECEPT_APPLICATION_ID ||
      !RECEPT_SCHEMA_VERSIONS.includes(version)) {
    throw new Error('未対応のRECEPT SQLite DBです。');
  }
  return version;
}

function inspectSnapshot(path: string) {
  assertNoCompanionFiles(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const databaseSchemaVersion = readDatabaseVersion(db);
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' ||
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new Error('SQLiteスナップショットの整合性検査に失敗しました。');
    }
    const tables = ['workspace', 'patients', 'diagnoses', 'billing_items', 'activity'];
    if (databaseSchemaVersion >= 2) tables.push('master_imports', 'master_rows');
    if (databaseSchemaVersion >= 3) tables.push('access_audit');
    if (databaseSchemaVersion >= 4) tables.push('claim_records', 'claim_draft_editor');
    if (databaseSchemaVersion >= 5) tables.push('staff_accounts');
    if (databaseSchemaVersion >= 6) tables.push('dencal_inbox', 'dencal_patient_matches');
    if (databaseSchemaVersion >= 7) tables.push('dencal_draft_applications', 'claim_month_editor');
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    if (tables.some((name) => !exists.get(name)) || !db.prepare('SELECT revision FROM workspace WHERE id = 1').get()) {
      throw new Error('RECEPTの必須テーブルまたは作業領域が見つかりません。');
    }
    const triggers = [];
    if (databaseSchemaVersion >= 3) triggers.push('access_audit_append_only', 'access_audit_no_update', 'access_audit_no_delete');
    if (databaseSchemaVersion >= 4) triggers.push('claim_records_append', 'claim_records_no_update', 'claim_records_no_delete');
    if (databaseSchemaVersion >= 6) triggers.push('dencal_inbox_no_update', 'dencal_inbox_no_delete', 'dencal_inbox_no_replace');
    const hasTrigger = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?");
    if (triggers.some((name) => !hasTrigger.get(name))) {
      throw new Error('監査ログまたは確定記録を保護するトリガーが見つかりません。');
    }
    if (databaseSchemaVersion >= 6) verifyDencalInbox(db);
    return {
      databaseSchemaVersion,
      auditCheckpoint: databaseSchemaVersion >= 3 ? verifyAccessAudit(db) : null,
      claimRecords: databaseSchemaVersion >= 4 ? verifyClaimRecords(db) : null,
    };
  } finally {
    db.close();
  }
}

function readGeneration(path: string) {
  const generation = protectedDirectory(resolve(path));
  const manifestPath = join(generation, manifestName);
  const file = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!file || !isPrivateFile(file) || file.size > 4096) {
    throw new Error('完了済みバックアップのマニフェストが見つからないか、権限または形式が不正です。');
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  return { generation, manifest, database: protectedDatabasePath(join(generation, databaseName)) };
}

async function verifySnapshot(path: string, manifest: Manifest) {
  assertNoCompanionFiles(path);
  const actual = await fingerprint(path);
  if (manifest.bytes !== actual.bytes || manifest.sha256 !== actual.sha256) {
    throw new Error('バックアップのサイズまたはSHA-256が一致しません。');
  }
  const integrity = inspectSnapshot(path);
  if (manifest.databaseSchemaVersion !== integrity.databaseSchemaVersion) {
    throw new Error('バックアップのDBスキーマ版がマニフェストと一致しません。');
  }
  return integrity;
}

export async function createBackup(destination: string) {
  const source = protectedDatabasePath();
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const directory = protectedDirectory(resolve(destination));
  const createdAt = new Date().toISOString();
  const generation = mkdtempSync(join(directory, `recept-${createdAt.replace(/[:.]/g, '')}-`));
  try {
    const database = join(generation, databaseName);
    writeFileSync(database, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA synchronous = FULL');
      readDatabaseVersion(db);
      db.prepare('VACUUM INTO ?').run(database);
    } finally {
      db.close();
    }
    syncPath(database);
    const integrity = inspectSnapshot(database);
    const manifest: Manifest = {
      formatVersion: 1, createdAt, databaseSchemaVersion: integrity.databaseSchemaVersion, ...await fingerprint(database),
    };
    const pending = join(generation, 'manifest.tmp');
    writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncPath(pending);
    renameSync(pending, join(generation, manifestName));
    syncDirectory(generation);
    syncDirectory(directory);
    return { generation, manifest, integrity };
  } catch (error) {
    rmSync(generation, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(path: string) {
  const { generation, manifest, database } = readGeneration(path);
  return { generation, manifest, integrity: await verifySnapshot(database, manifest) };
}

export async function restoreBackup(path: string, output: string) {
  const { generation, manifest, database } = readGeneration(path);
  assertNoCompanionFiles(database);
  const requested = resolve(output);
  if (!requested.endsWith('.sqlite3')) throw new Error('復元先は新しい .sqlite3 ファイルを指定してください。');
  const directory = protectedDirectory(dirname(requested));
  const target = join(directory, basename(requested));
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error('復元先が既に存在します。');
  assertNoCompanionFiles(target);

  const staging = mkdtempSync(join(directory, '.recept-restore-'));
  try {
    const staged = join(staging, databaseName);
    copyFileSync(database, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o600);
    const integrity = await verifySnapshot(staged, manifest);
    syncPath(staged);
    assertNoCompanionFiles(target);
    // Same filesystem, atomic publication, and no replacement of an existing target.
    linkSync(staged, target);
    rmSync(staged);
    syncDirectory(directory);
    return { generation, restoredDatabase: target, manifest, integrity };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
