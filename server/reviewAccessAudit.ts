import { DatabaseSync } from 'node:sqlite';
import { protectedDatabasePath } from './databaseFiles';
import { readAccessAudit, verifyAccessAudit } from './accessAudit';

function integer(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('連番または件数の指定が正しくありません。');
  }
  return parsed;
}

function main(args: string[]) {
  const [mode, first, second] = args;
  if ((mode !== 'review' && mode !== 'verify') || args.length > (mode === 'verify' ? 2 : 3)) {
    throw new Error('使い方: npm run audit -- review [前回の連番] [最大件数] または verify [連番:ハッシュ]');
  }

  const db = new DatabaseSync(protectedDatabasePath(), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x52435054 ||
        ![3, 4, 5].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version))) {
      throw new Error('RECEPTの監査ログ対応DBを指定してください。');
    }
    if (mode === 'verify') {
      const match = first === undefined ? undefined : /^(\d+):([0-9a-f]{64})$/.exec(first);
      if (match === null) throw new Error('チェックポイントは「連番:ハッシュ」で指定してください。');
      const checkpoint = match ? { seq: integer(match[1], 0), hash: match[2] } : undefined;
      const result = verifyAccessAudit(db, checkpoint);
      console.log(`${result.seq}:${result.hash}`);
    } else {
      const after = integer(first ?? '0', 0);
      const limit = integer(second ?? '100', 1, 1000);
      for (const entry of readAccessAudit(db, after, limit)) console.log(JSON.stringify(entry));
    }
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : '監査ログの確認に失敗しました。');
  process.exitCode = 1;
}
