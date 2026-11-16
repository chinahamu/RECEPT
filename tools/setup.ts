/**
 * One-command first-time RECEPT setup.
 *
 * Source files are user-provided and are neither downloaded nor redistributed.
 * A private temporary directory holds the database until every import validates.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MASTER_MAX_BYTES, OFFICIAL_MASTERS, officialFilename, type MasterKind } from '../src/data/officialMasters';
import { masterFileParams } from '../server/officialMasters';
import { openWorkspace } from '../server/workspace';
import { RECEPT_APPLICATION_ID } from '../server/databaseFiles';

const root = fileURLToPath(new URL('../', import.meta.url));
const kinds = Object.keys(OFFICIAL_MASTERS) as MasterKind[];
const masterPattern = /^(?:[sytc]_[0-9]{8}\.csv|[bz]_[0-9]{8}\.txt|k(?:_[0-9]{8})?\.csv)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

type Options = { input: string; database: string };
type InputFile = { name: string; path: string; publishedOn: string };
type ImportSummary = { kind: MasterKind; file: string; publishedOn: string; count: number; sha256: string };

function optionsFromArgv(): Options {
  const options: Options = {
    input: resolve(root, 'setup-input'),
    database: resolve(process.env.RECEPT_DB || join(root, 'data/recept.sqlite3')),
  };
  let positional = false;
  for (let i = 0; i < process.argv.slice(2).length; i++) {
    const argv = process.argv.slice(2);
    const key = argv[i];
    if (key === '--help' || key === '-h') {
      console.log('npm run db:init -- [--input setup-input] [--db data/recept.sqlite3]');
      console.log('従来どおり、出力ファイルを位置引数として指定することもできます。');
      process.exit(0);
    }
    if (key === '--db' || key === '--input') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(key + ' のパスを指定してください。');
      options[key === '--db' ? 'database' : 'input'] = resolve(value);
    } else if (!key.startsWith('-') && !positional) {
      positional = true;
      options.database = resolve(key);
    } else throw new Error('不明な引数: ' + key);
  }
  if (!options.database.endsWith('.sqlite3')) throw new Error('DB名は .sqlite3 で終わる必要があります。');
  return options;
}

function actualDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function discoverMasters(input: string): InputFile[] {
  const folder = join(input, 'masters');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error('公式マスター配置先がありません: ' + folder);
  }
  const names = readdirSync(folder).sort();
  const found = names.filter(name => masterPattern.test(name));
  const unknown = names.filter(name => /\.(csv|txt)$/i.test(name) && !masterPattern.test(name));
  if (unknown.length) throw new Error('マスターファイル名を確認してください: ' + unknown.join(', '));
  const present = new Set<MasterKind>();
  for (const name of found) present.add(name[0] as MasterKind);
  const missing = kinds.filter(kind => !present.has(kind));
  if (missing.length) {
    throw new Error('公式マスター7種類が必要です。不足: ' +
      missing.map(kind => OFFICIAL_MASTERS[kind] + '(' + kind + ')').join('、'));
  }
  const metadataPath = join(folder, 'published-on.json');
  let metadata: Record<string, unknown> = {};
  if (existsSync(metadataPath)) {
    const value: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('published-on.json はファイル名と更新日の対応表にしてください。');
    }
    metadata = value as Record<string, unknown>;
  }
  // Every metadata entry must refer to an actual file; no silently ignored dates.
  for (const key of Object.keys(metadata)) {
    if (!found.includes(key)) throw new Error('published-on.json に存在しないマスター名があります: ' + key);
  }
  const result: InputFile[] = [];
  for (const name of found) {
    const match = officialFilename.exec(name);
    if (!match) throw new Error('未対応のファイル名です: ' + name);
    const publishedOn = match[2] ? `${match[2]}-${match[3]}-${match[4]}` : metadata[name];
    if (typeof publishedOn !== 'string' || !actualDate(publishedOn)) {
      throw new Error('配布ページで確認した更新日を published-on.json に記載してください: ' + name);
    }
    if (metadata[name] !== undefined && metadata[name] !== publishedOn) {
      throw new Error('published-on.json の日付がファイル名と一致しません: ' + name);
    }
    const path = join(folder, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('通常のマスターファイルを配置してください: ' + path);
    }
    if (!info.size || info.size > MASTER_MAX_BYTES) {
      throw new Error('20 MiB以下の公式マスターを指定してください: ' + name);
    }
    masterFileParams(name, publishedOn);
    result.push({ name, path, publishedOn });
  }
  // Import older releases before newer ones.
  return result.sort((a, b) => a.publishedOn.localeCompare(b.publishedOn) || a.name.localeCompare(b.name));
}

function locatePython(): string[] {
  const paths = process.env.RECEPT_PYTHON
    ? [[process.env.RECEPT_PYTHON]]
    : process.platform === 'win32'
      ? [['py', '-3'], ['python'], ['python3']]
      : [['python3'], ['python']];
  for (const candidate of paths) {
    const check = spawnSync(candidate[0], [...candidate.slice(1), '-c',
      'import sys,sqlite3; assert sys.version_info >= (3,10); assert sqlite3.sqlite_version_info >= (3,31)'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    if (check.status === 0) return candidate;
  }
  throw new Error('Python 3.10以降（SQLite 3.31以降）が必要です。RECEPT_PYTHON でPythonを指定できます。');
}

function ensurePrivateDirectory(folder: string) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stats = statSync(folder);
  if (!stats.isDirectory()) throw new Error('DB保存先がフォルダではありません: ' + folder);
  if (process.getuid && (stats.uid !== process.getuid() || (stats.mode & 0o022))) {
    throw new Error('DB保存先は起動ユーザーが所有し、他のユーザーが書込不可にしてください: ' + folder);
  }
}

export function setup(options: Options) {
  const database = resolve(options.database);
  const reportFile = join(dirname(database), 'initial-setup-report.json');
  const files = discoverMasters(resolve(options.input));
  if (existsSync(database)) throw new Error('既存DBの上書きを拒否しました: ' + database);
  if (existsSync(reportFile)) throw new Error('既存の初期セットアップレポートがあります: ' + reportFile);
  const python = locatePython();
  ensurePrivateDirectory(dirname(database));
  const stageDir = mkdtempSync(join(dirname(database), '.recept-setup-'));
  const stageFile = join(stageDir, 'recept.sqlite3');
  const stageReport = join(stageDir, 'initial-setup-report.json');
  let databasePublished = false;
  let reportPublished = false;
  try {
    const initialized = spawnSync(python[0], [
      ...python.slice(1), join(root, 'database/init.py'), stageFile,
    ], { encoding: 'utf8', cwd: root, timeout: 120000 });
    if (initialized.error || initialized.status !== 0) {
      throw new Error('SQLite初期化に失敗しました: ' +
        (initialized.stderr?.trim() || initialized.error?.message || initialized.stdout?.trim() || initialized.status));
    }

    const imported: ImportSummary[] = [];
    const store = openWorkspace(stageFile);
    try {
      for (const { name, path, publishedOn } of files) {
        const result = store.masters.import(masterFileParams(name, publishedOn), readFileSync(path));
        imported.push({
          kind: result.entry.kind, file: name, publishedOn,
          count: result.entry.rowCount, sha256: result.entry.sha256,
        });
      }
    } finally {
      store.close();
    }

    const check = new DatabaseSync(stageFile, { readOnly: true });
    try {
      const version = check.prepare('PRAGMA user_version').get()?.user_version;
      const appId = check.prepare('PRAGMA application_id').get()?.application_id;
      const integrity = check.prepare('PRAGMA integrity_check').get()?.integrity_check;
      const fk = check.prepare('PRAGMA foreign_key_check').all();
      if (version !== 7 || appId !== RECEPT_APPLICATION_ID || integrity !== 'ok' || fk.length) {
        throw new Error('生成DBの整合性を検証できませんでした。');
      }
      const kindsCount = check.prepare('SELECT count(DISTINCT kind) AS n FROM master_imports').get()?.n;
      if (kindsCount !== kinds.length) throw new Error('7種類の公式マスターが取込済みではありません。');
    } finally {
      check.close();
    }
    const report = {
      initializedAt: new Date().toISOString(),
      database, imports: imported,
      kinds: kinds.length, files: imported.length,
      totalRows: imported.reduce((n, m) => n + m.count, 0),
    };
    writeFileSync(stageReport, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    // Hard links fail if the target already exists: concurrent processes cannot overwrite anything.
    linkSync(stageFile, database);
    databasePublished = true;
    linkSync(stageReport, reportFile);
    reportPublished = true;
    console.log('RECEPT 初期セットアップ完了');
    console.log('公式マスター ' + kinds.length + '/7種類、' + imported.length +
      'ファイル、' + report.totalRows.toLocaleString() + '行');
    for (const row of imported) console.log(row.file + ': ' + row.count.toLocaleString() + '行');
    console.log('DB: ' + database);
    console.log('取込結果: ' + reportFile);
    console.log('次に npm run staff -- create demo-admin admin で管理者を登録してください。');
    return report;
  } catch (error) {
    if (reportPublished) unlinkSync(reportFile);
    if (databasePublished) unlinkSync(database);
    throw error;
  } finally {
    rmSync(stageDir, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    setup(optionsFromArgv());
  } catch (error) {
    console.error('初期セットアップ失敗: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
