import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openWorkspace } from '../server/workspace';
import { RECEPT_APPLICATION_ID } from '../server/databaseFiles';

const root = fileURLToPath(new URL('../', import.meta.url));
const setupScript = fileURLToPath(new URL('./setup.ts', import.meta.url));

function buildRow(kind: string, code: string) {
  const widths: Record<string, number> = { s: 150, y: 42, t: 38, b: 46, z: 19, c: 30, k: 150 };
  const names: Record<string, number> = { s: 112, y: 34, t: 36, b: 5, z: 6, c: 6, k: 112 };
  const fields = Array<string>(widths[kind]).fill('');
  fields[0] = '0';
  fields[1] = kind === 'k' ? 'S' : kind.toUpperCase();
  fields[kind === 'c' ? 22 : 2] = code;
  fields[names[kind]] = '架空のテスト' + kind;
  if (kind === 's') {
    fields[10] = '3'; fields[11] = '200'; fields[12] = '0';
    fields[14] = '110'; fields[15] = '0'; fields[29] = '0'; fields[86] = '20261101';
  }
  if (kind === 'b') { fields[18] = '00'; fields[19] = '0'; fields[21] = '20261101'; }
  return fields.map(v => '"' + v.replaceAll('"', '""') + '"').join(',') + '\r\n';
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'recept-first-setup-'));
  const input = join(base, 'setup-input');
  const masters = join(input, 'masters');
  mkdirSync(masters, { recursive: true, mode: 0o700 });
  const files = [
    ['s_20261102.csv', 's', '111000110'],
    ['y_20261013.csv', 'y', '612345678'],
    ['t_20261001.csv', 't', '712345678'],
    ['b_20260601.txt', 'b', '0001000'],
    ['z_20260601.txt', 'z', '1234'],
    ['c_20261001.csv', 'c', '810000001'],
    ['k.csv', 'k', '190000001'],
  ];
  for (const [filename, kind, code] of files) {
    writeFileSync(join(masters, filename), buildRow(kind, code));
  }
  writeFileSync(join(masters, 'published-on.json'), JSON.stringify({ 'k.csv': '2026-07-03' }));
  const database = join(base, 'data', 'recept.sqlite3');
  return { base, input, masters, database, report: join(base, 'data', 'initial-setup-report.json') };
}

function run(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, ['--import', 'tsx', setupScript, '--input', f.input, '--db', f.database],
    { cwd: root, encoding: 'utf8', timeout: 120000 });
}

test('7 kinds are imported and schema is migrated to v7 in one command', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const result = run(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(lstatSync(f.database).nlink, 1);
  assert.equal(lstatSync(f.database).mode & 0o077, 0);
  assert.ok(existsSync(f.report));
  const report = JSON.parse(readFileSync(f.report, 'utf8')) as { kinds: number; files: number; totalRows: number };
  assert.deepEqual([report.kinds, report.files, report.totalRows], [7, 7, 7]);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7);
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, RECEPT_APPLICATION_ID);
    assert.equal(db.prepare('SELECT count(*) AS n FROM master_imports').get()?.n, 7);
    assert.equal(db.prepare('SELECT count(*) AS n FROM master_rows').get()?.n, 7);
    assert.equal(db.prepare('SELECT seeded FROM workspace WHERE id = 1').get()?.seeded, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { db.close(); }
  const store = openWorkspace(f.database);
  try {
    assert.equal(store.masters.list().length, 7);
    assert.equal(store.masters.list().find(m => m.kind === 'k')?.publishedOn, '2026-07-03');
  } finally { store.close(); }
  const again = run(f);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /既存DBの上書き/);
  assert.equal(lstatSync(f.database).nlink, 1);
});

test('missing or invalid official master never publishes an incomplete DB', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  rmSync(join(f.masters, 'b_20260601.txt'));
  const missing = run(f);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /不足/);
  assert.equal(existsSync(f.database), false);
  writeFileSync(join(f.masters, 'b_20260601.txt'), 'invalid');
  const invalid = run(f);
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(f.database), false);
  assert.equal(existsSync(f.report), false);
});

test('undated ward master requires explicit official publication date', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  rmSync(join(f.masters, 'published-on.json'));
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /published-on.json/);
  assert.equal(existsSync(f.database), false);
});

test('setup must not overwrite a pre-existing database', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  mkdirSync(join(f.base, 'data'), { recursive: true, mode: 0o700 });
  writeFileSync(f.database, 'existing-data');
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.database, 'utf8'), 'existing-data');
  assert.equal(existsSync(f.report), false);
});
