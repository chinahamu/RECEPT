import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { INITIAL_PATIENTS } from '../src/data/demoWorkspace';
import type { WorkspaceAction } from '../src/types/workspace';
import { createWorkspaceApi } from './api';
import { requestSchema } from './validation';
import { openWorkspace, WorkspaceError } from './workspace';
import { readAccessAudit, verifyAccessAudit } from './accessAudit';
import { masterFileParams } from './officialMasters';

function setup(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'recept-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'recept.sqlite3');
  execFileSync('python3', ['database/init.py', filename]);
  return filename;
}

const command = (revision: number, action: WorkspaceAction) => requestSchema.parse({ revision, action });

test('SQLite stores patients, details and activity across a server restart', (t) => {
  const filename = setup(t);
  const store = openWorkspace(filename);
  try {
    const initial = store.read();
    assert.equal(initial.patients.length, INITIAL_PATIENTS.length);
    assert.equal(initial.patients[0].calculation.totalPoints, 549);

    const registered = store.apply(command(initial.revision, {
      type: 'register', patient: { ...INITIAL_PATIENTS[0], name: '架空 登録', diagnoses: [], billingItems: [] },
    })).workspace;
    const newPatient = registered.patients[0];
    assert.equal(newPatient.name, '架空 登録');
    assert.notEqual(newPatient.id, INITIAL_PATIENTS[0].id);
    assert.equal(registered.activity[0].actionType, 'PATIENT_REGISTER');

    const fields = Array<string>(150).fill('0');
    Object.assign(fields, { 1: 'S', 2: '111000110', 4: 'テスト初診料', 9: '回', 10: '3', 11: '291.00', 14: '110', 86: '20260601', 87: '99999999', 112: '' });
    const entry = { ...INITIAL_PATIENTS[0].billingItems[0], code: '111000110', points: 99_999, date: '2026-11-10' };
    assert.throws(() => store.apply(command(registered.revision, {
      type: 'update', patientId: newPatient.id, diagnoses: [], billingItems: [entry], summary: '未取込',
    })), (error) => error instanceof WorkspaceError && error.status === 400);
    store.masters.import(masterFileParams('s_20261102.csv', '2026-11-02'), Buffer.from(fields.join(',')));

    const disease = Array<string>(46).fill('');
    Object.assign(disease, { 0: '0', 1: 'B', 2: '0001000', 5: 'テスト傷病名', 15: 'I10', 18: '00', 19: '0', 21: '20260601', 23: '99999999' });
    store.masters.import(masterFileParams('b_20260601.txt', '2026-06-01'), Buffer.from(disease.join(',')));
    assert.deepEqual(store.clinical.search('b', 'テスト'), [{ code: '0001000', name: 'テスト傷病名', icd10: 'I10' }]);
    assert.equal(store.clinical.search('s', 'テスト')[0]?.points, 291);

    const populated = store.apply(command(registered.revision, {
      type: 'update', patientId: newPatient.id,
      diagnoses: [{ ...INITIAL_PATIENTS[0].diagnoses[0], diseaseCode: '0001000', startDate: '2026-11-10' }],
      billingItems: [entry], summary: '公式マスターから登録',
    })).workspace;
    assert.equal(populated.patients[0].diagnoses[0].diseaseName, 'テスト傷病名');
    const firstItem = populated.patients[0].billingItems[0];
    assert.equal(firstItem.points, 291);
    const modifiedItems = populated.patients[0].billingItems.map((item) =>
      item.id === firstItem.id ? { ...item, quantity: 2, points: 99_999, commentText: '保存確認' } : item);
    const updated = store.apply(command(populated.revision, {
      type: 'update', patientId: newPatient.id, diagnoses: populated.patients[0].diagnoses,
      billingItems: modifiedItems, summary: 'デモ明細変更',
    })).workspace;
    assert.equal(updated.patients[0].billingItems[0].points, firstItem.points);
    assert.equal(updated.patients[0].linePoints[firstItem.id], firstItem.points * 2 * firstItem.days);

    const finalized = store.apply(command(updated.revision, { type: 'finalize', patientId: newPatient.id })).workspace;
    assert.match(finalized.activity[0].summary, /デモ会計確定.*総点数/);
    const output = store.apply(command(finalized.revision, { type: 'exportCsv' }));
    assert.match(output.claim?.csv ?? '', /^DEMO,.*架空 登録/s);
  } finally {
    store.close();
  }

  const reopened = openWorkspace(filename);
  try {
    const state = reopened.read();
    assert.equal(state.patients[0].billingItems[0].commentText, '保存確認');
    assert.equal(state.patients[0].diagnoses.length, 1);
    assert.equal(state.activity[0].actionType, 'CSV_EXPORT');
  } finally {
    reopened.close();
  }

  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.ok(Number(db.prepare('SELECT count(*) AS count FROM billing_items').get()?.count) > 0);
    assert.ok(Number(db.prepare('SELECT count(*) AS count FROM diagnoses').get()?.count) > 0);
  } finally {
    db.close();
  }
  assert.throws(() => execFileSync('python3', ['database/init.py', filename], { stdio: 'pipe' }));
});

test('stale commands and failed updates leave no partial writes', (t) => {
  const filename = setup(t);
  const first = openWorkspace(filename);
  const second = openWorkspace(filename);
  t.after(() => { first.close(); second.close(); });
  const initial = first.read();
  const patient = initial.patients.find((entry) => entry.findings.some((finding) => finding.fixAction))!;
  const finding = patient.findings.find((entry) => entry.fixAction);
  assert.ok(finding);
  const fixed = first.apply(command(initial.revision, {
    type: 'fix', patientId: patient.id, findingId: finding.id,
  })).workspace;
  assert.equal(fixed.activity[0].actionType, 'AUDIT_AUTO_FIX');
  assert.throws(() => second.apply(command(initial.revision, { type: 'reset' })),
    (error) => error instanceof WorkspaceError && error.status === 409);
  const unknown = { ...patient.billingItems[0], id: 'unknown', code: '999999999' };
  assert.throws(() => second.apply(command(fixed.revision, {
    type: 'update', patientId: patient.id, diagnoses: [], billingItems: [unknown], summary: '不正コード',
  })), (error) => error instanceof WorkspaceError && error.status === 400);
  assert.deepEqual(second.read(), fixed);

  const batch = first.apply(command(fixed.revision, { type: 'batchFix' })).workspace;
  assert.equal(batch.activity[0].patientChartNumber, 'ALL-RECEIPTS');
  const reset = first.apply(command(batch.revision, { type: 'reset' })).workspace;
  assert.deepEqual(reset.patients.map((entry) => entry.id), INITIAL_PATIENTS.map((entry) => entry.id));
  assert.deepEqual(reset.activity, []);
});

function requestApi(api: ReturnType<typeof createWorkspaceApi>) {
  return function request(url: string, method: string, value?: unknown, origin?: string) {
    const raw = Buffer.isBuffer(value);
    const body = raw ? value : Buffer.from(JSON.stringify(value ?? null));
    const req = Object.assign(Readable.from(value === undefined ? [] : [body]), {
      url, method,
      headers: {
        host: 'localhost:5173', 'content-type': raw ? 'application/octet-stream' : 'application/json', origin,
        'x-user-id': 'untrusted-client-identity',
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    return new Promise<{ status: number; data: any }>((resolve, reject) => {
      let status = 0;
      const res = {
        setHeader() {},
        writeHead(code: number) { status = code; },
        end(body: string) { resolve({ status, data: JSON.parse(body) }); },
      };
      api.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => reject(new Error('Unexpected next()')));
    });
  };
}

test('workspace HTTP middleware serves JSON and rejects cross-origin or malformed writes', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename));
  t.after(api.close);
  const request = requestApi(api);
  assert.equal((await request('/api/workspace', 'GET')).status, 200);
  assert.equal((await request('/api/workspace', 'POST', {}, 'https://example.org')).status, 403);
  assert.equal((await request('/api/workspace', 'POST', {})).status, 400);
  const result = await request('/api/workspace', 'POST', command(0, { type: 'toggleOffline' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.workspace.isOfflineMode, true);
  assert.match((await request('/api/claim-preview', 'GET')).data.csv, /^DEMO,/);

  const masterUrl = '/api/official-masters';
  const uploadUrl = `${masterUrl}?filename=c_20261110.csv&publishedOn=2026-11-10`;
  const comment = Array<string>(30).fill('0');
  comment.splice(1, 6, 'C', '8', '10', '1', '0', '');
  comment[22] = '810000001';
  const valid = Buffer.from(comment.map((field) => `"${field}"`).join(',') + '\r\n');
  assert.equal((await request(uploadUrl, 'POST', valid, 'https://example.org')).status, 403);
  assert.equal((await request(uploadUrl, 'POST', Buffer.concat([valid, Buffer.from('invalid')]))).status, 400);
  assert.deepEqual((await request(masterUrl, 'GET')).data, []);

  const imported = await request(uploadUrl, 'POST', valid);
  assert.equal(imported.status, 200);
  assert.equal(imported.data.entry.rowCount, 1);
  assert.equal((await request(uploadUrl, 'POST', valid)).data.duplicate, true);
  assert.deepEqual((await request(`${masterUrl}?id=${imported.data.entry.id}&q=810`, 'GET')).data, [
    { code: '810000001', name: '自由記載' },
  ]);
  assert.equal((await request('/api/workspace', 'POST', command(1, { type: 'reset' }))).status, 200);
  api.close();
  assert.equal((await request(masterUrl, 'GET')).data.length, 1);
  const db = new DatabaseSync(filename, { readOnly: true });
  t.after(() => db.close());
  const imports = readAccessAudit(db, 0, 100).map(({ event }) => event)
    .filter(({ operation }) => operation === 'import-master');
  assert.deepEqual(imports.map(({ status, masterImportId, duplicate }) => [status, masterImportId, duplicate]), [
    [400, undefined, undefined], [200, imported.data.entry.id, false], [200, imported.data.entry.id, true],
  ]);
});


test('access audit records API disclosure, changes and failures across reset and restart', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename));
  t.after(api.close);
  const request = requestApi(api);
  await request('/api/workspace', 'GET');
  const registration = await request('/api/workspace', 'POST', command(0, {
    type: 'register', patient: { ...INITIAL_PATIENTS[0], name: 'ログに保存しない氏名', diagnoses: [], billingItems: [] },
  }));
  assert.equal(registration.status, 200);
  const patientId = registration.data.workspace.patients[0].id;
  assert.equal((await request('/api/workspace', 'POST', command(1, { type: 'snapshot' }))).status, 200);
  assert.equal((await request('/api/workspace', 'POST', command(2, { type: 'exportCsv' }))).status, 200);
  assert.equal((await request('/api/claim-preview', 'GET')).status, 200);
  assert.equal((await request('/api/workspace', 'POST', command(0, { type: 'reset' }))).status, 409);
  assert.equal((await request('/api/workspace', 'POST', command(3, { type: 'reset' }))).status, 200);
  assert.equal((await request('/api/workspace', 'POST', {}, 'https://example.org')).status, 403);
  assert.equal((await request('/api/claim-preview', 'POST')).status, 405);
  api.close();
  await request('/api/workspace', 'GET');

  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  const events = readAccessAudit(db, 0, 100).map(({ event }) => event);
  assert.deepEqual(events.map(({ operation, status }) => [operation, status]), [
    ['read', 200], ['register', 200], ['snapshot', 200], ['exportCsv', 200], ['read', 200],
    ['reset', 409], ['reset', 200], ['write', 403], ['write', 405], ['read', 200],
  ]);
  assert.equal(new Set(events.map(({ requestId }) => requestId)).size, events.length);
  assert.ok(events.every(({ requestedAt, recordedAt }) => !Number.isNaN(Date.parse(requestedAt)) &&
    !Number.isNaN(Date.parse(recordedAt))));
  assert.ok(events.every(({ actor }) => actor.kind === 'anonymous'));
  assert.deepEqual(events[1].affectedPatientIds, [patientId]);
  assert.ok(events[2].patientIds?.includes(patientId));
  assert.ok(events[3].patientIds?.includes(patientId));
  assert.ok(events[4].patientIds?.includes(patientId));
  assert.equal(events[5].patientIds, undefined);
  assert.ok(events[6].affectedPatientIds?.includes(patientId));
  assert.equal(events[6].patientIds?.includes(patientId), false);
  assert.doesNotMatch(JSON.stringify(events), /ログに保存しない氏名|untrusted-client-identity/);

  const checkpoint = verifyAccessAudit(db);
  assert.equal(checkpoint.seq, events.length);
  const auditCli = (...args: string[]) => execFileSync(process.execPath,
    ['--import', 'tsx', 'server/reviewAccessAudit.ts', ...args], {
      encoding: 'utf8', env: { ...process.env, RECEPT_DB: filename },
    }).trim();
  assert.equal(auditCli('verify'), `${checkpoint.seq}:${checkpoint.hash}`);
  assert.equal(JSON.parse(auditCli('review', '1', '1')).event.operation, 'register');
  assert.throws(() => db.exec("UPDATE access_audit SET payload = '{}' WHERE seq = 1"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM access_audit WHERE seq = 1'), /append-only/);
  assert.throws(() => db.exec('INSERT OR REPLACE INTO access_audit SELECT * FROM access_audit WHERE seq = 1'), /appended/);
  db.exec('DROP TRIGGER access_audit_no_delete; DELETE FROM access_audit WHERE seq = (SELECT max(seq) FROM access_audit)');
  assert.throws(() => verifyAccessAudit(db, checkpoint), /チェックポイント/);
});

test('audit stores only a trusted actor and blocks reads and writes when their audit append fails', async (t) => {
  const filename = setup(t);
  const actor = { kind: 'authenticated', userId: 'staff-001', loginAt: '2026-11-11T00:00:00.000Z' } as const;
  const api = createWorkspaceApi(() => openWorkspace(filename), async () => ({ ...actor, token: 'do-not-log' }));
  t.after(api.close);
  const request = requestApi(api);
  assert.equal((await request('/api/workspace', 'GET')).status, 200);
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  assert.deepEqual(readAccessAudit(db, 0, 1)[0].event.actor, actor);

  db.exec(`CREATE TRIGGER fail_success_audit BEFORE INSERT ON access_audit
    WHEN json_extract(NEW.payload, '$.status') = 200 BEGIN SELECT raise(ABORT, 'audit write failed'); END`);
  const read = await request('/api/workspace', 'GET');
  assert.equal(read.status, 500);
  assert.equal(read.data.patients, undefined);
  assert.equal((await request('/api/workspace', 'POST', command(0, { type: 'toggleOffline' }))).status, 500);
  assert.equal(db.prepare('SELECT revision FROM workspace').get()?.revision, 0);
  assert.deepEqual(readAccessAudit(db, 1, 100).map(({ event }) => event.status), [500, 500]);
});


test('an existing version 2 database is migrated without deleting legacy activity', (t) => {
  const filename = setup(t);
  const db = new DatabaseSync(filename);
  try {
    db.exec(readFileSync(new URL('../database/002-official-masters.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO activity (entry) VALUES ('{"summary":"既存の操作履歴"}')`);
  } finally {
    db.close();
  }

  const store = openWorkspace(filename);
  try {
    assert.equal(store.read().activity[0].summary, '既存の操作履歴');
  } finally {
    store.close();
  }
  const migrated = new DatabaseSync(filename, { readOnly: true });
  t.after(() => migrated.close());
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.deepEqual(readAccessAudit(migrated, 0, 100), []);
});
