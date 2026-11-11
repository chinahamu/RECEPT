import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { WorkspaceError } from './errors';

export const RECEPT_APPLICATION_ID = 0x52435054;
export const RECEPT_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6];

export const databaseFileSuffixes = ['', '-journal', '-wal', '-shm'];

export function protectedDirectory(path: string) {
  const directory = realpathSync(path);
  const folder = statSync(directory);
  const uid = process.getuid?.();
  if (!folder.isDirectory() || (uid !== undefined && (folder.uid !== uid || (folder.mode & 0o022) !== 0))) {
    throw new WorkspaceError(503, 'DBは、起動ユーザーが所有し他のユーザーが書き込めないディレクトリに置いてください。');
  }
  return directory;
}

export function isPrivateFile(file: Stats) {
  const uid = process.getuid?.();
  return file.isFile() && file.nlink === 1 &&
    (uid === undefined || (file.uid === uid && (file.mode & 0o077) === 0));
}

export function protectedDatabasePath(path = process.env.RECEPT_DB || 'data/recept.sqlite3') {
  const requested = resolve(path);
  const missing = 'SQLite DBを開けません。npm run db:init と RECEPT_DB の設定を確認してください。';
  if (!requested.endsWith('.sqlite3')) throw new WorkspaceError(503, missing);

  let directory: string;
  try {
    directory = protectedDirectory(dirname(requested));
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(503, missing);
  }

  const filename = resolve(directory, basename(requested));
  for (const suffix of databaseFileSuffixes) {
    const file = lstatSync(filename + suffix, { throwIfNoEntry: false });
    if (!file) {
      if (suffix === '') throw new WorkspaceError(503, missing);
      continue;
    }
    if (!isPrivateFile(file)) {
      throw new WorkspaceError(503, 'DBと関連ファイルは、リンクではない通常ファイルを使用し、起動ユーザーだけがアクセスできるようにしてください。');
    }
  }
  return filename;
}
