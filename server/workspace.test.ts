import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { INITIAL_PATIENTS } from '../src/data/demoWorkspace';
import type { WorkspaceAction } from '../src/types/workspace';
import { createWorkspaceApi as createAuthenticatedApi } from './api';
import { staffSessions } from './staffSessions';
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
  const store = openWorkspace(filename, true);
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

    const preview = store.previewConfirmation(newPatient.id);
    const result = store.apply(command(preview.revision, {
      type: 'finalize', patientId: newPatient.id, reviewHash: preview.reviewHash,
    }));
    const finalized = result.workspace;
    assert.deepEqual(result.claimRecord?.snapshot.masters.map(({ kind }) => kind), ['s', 'b']);
    assert.equal(result.claimRecord?.snapshot.patient.billingItems[0].masterImportId, 1);
    assert.equal(result.claimRecord?.snapshot.patient.diagnoses[0].masterImportId, 2);
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

function testSession(userId = 'test-admin', loginAt = '2026-11-11T00:00:00.000Z') {
  return { staff: { id: userId, role: 'admin' as const }, sessionId: 'test-session', loginAt, expiresAt: Date.now() + 1_800_000 };
}

function createWorkspaceApi(open: typeof openWorkspace, resolve = testSession) {
  return createAuthenticatedApi(open, () => resolve());
}

function requestApi(api: ReturnType<typeof createWorkspaceApi>) {
  return function request(url: string, method: string, value?: unknown, origin?: string, fetchSite?: string, cookie?: string, sessionId?: string) {
    const raw = Buffer.isBuffer(value);
    const body = raw ? value : Buffer.from(JSON.stringify(value ?? null));
    const req = Object.assign(Readable.from(value === undefined ? [] : [body]), {
      url, method,
      headers: {
        host: 'localhost:5173', 'content-type': raw ? 'application/octet-stream' : 'application/json', origin,
        'x-user-id': 'untrusted-client-identity', 'sec-fetch-site': fetchSite, cookie, 'x-recept-session': sessionId,
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    return new Promise<{ status: number; data: any; headers: Record<string, string> }>((resolve, reject) => {
      let status = 0;
      let headers: Record<string, string> = {};
      const res = {
        setHeader(name: string, value: string) { headers[name] = value; },
        writeHead(code: number, responseHeaders: Record<string, string>) { status = code; headers = { ...headers, ...responseHeaders }; },
        end(body: string) { resolve({ status, data: JSON.parse(body), headers }); },
      };
      api.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => reject(new Error('Unexpected next()')));
    });
  };
}

test('workspace HTTP middleware serves JSON and rejects cross-origin or malformed writes', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename, true));
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
  const api = createWorkspaceApi(() => openWorkspace(filename, true));
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
  assert.equal(events[7].actor.kind, 'anonymous');
  assert.ok(events.filter((_, i) => i !== 7).every(({ actor }) => actor.kind === 'authenticated'));
  assert.deepEqual(events[1].affectedPatientIds, [patientId]);
  assert.ok(events[2].patientIds?.includes(patientId));
  assert.ok(events[3].patientIds?.includes(patientId));
  assert.deepEqual(events[4].patientIds, []); // Drafts are excluded from claim CSV.
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
  const api = createWorkspaceApi(() => openWorkspace(filename), () => ({ ...testSession(actor.userId, actor.loginAt), token: 'do-not-log' }));
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
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 7);
  assert.deepEqual(readAccessAudit(migrated, 0, 100), []);
});


test('claim confirmation freezes the reviewed version, requires a correction reason and preserves history across reset', async (t) => {
  const filename = setup(t);
  const editor = { kind: 'authenticated', userId: 'staff-input', loginAt: '2026-11-11T00:00:00.000Z' } as const;
  const confirmer = { ...editor, userId: 'staff-confirm' };
  let actor: typeof editor | typeof confirmer = editor;
  const api = createWorkspaceApi(() => openWorkspace(filename, true), () => testSession(actor.userId, actor.loginAt));
  t.after(api.close);
  const request = requestApi(api);
  const patient = INITIAL_PATIENTS[0];
  const previewUrl = `/api/claim-records?patientId=${patient.id}`;
  const finalize = (review: { revision: number; reviewHash: string }, correctionReason?: string) =>
    request('/api/workspace', 'POST', command(review.revision, {
      type: 'finalize', patientId: patient.id, reviewHash: review.reviewHash, correctionReason,
    }));
  const edit = (revision: number, quantity: number) =>
    request('/api/workspace', 'POST', command(revision, {
      type: 'update', patientId: patient.id, diagnoses: patient.diagnoses,
      billingItems: patient.billingItems.map((item, index) => index === 0 ? { ...item, quantity } : item),
      summary: 'テスト明細の数量変更',
    }));

  const firstView = (await request(previewUrl, 'GET')).data;
  assert.equal(firstView.previous, null);
  assert.equal((await request('/api/claim-preview', 'GET')).data.patientCount, 0);
  assert.equal((await edit(firstView.revision, 2)).status, 200);
  const reviewed = (await request(previewUrl, 'GET')).data;
  actor = confirmer;
  assert.equal((await finalize(firstView)).status, 409);
  assert.equal((await finalize({ ...reviewed, reviewHash: '0'.repeat(64) })).status, 409);
  const first = (await finalize(reviewed)).data.claimRecord;
  assert.equal(first.version, 1);
  assert.deepEqual(first.confirmedBy, confirmer);
  assert.deepEqual(first.enteredBy.actor, editor);
  assert.deepEqual(first.snapshot, reviewed.snapshot);
  assert.equal(first.snapshot.patient.notes, undefined);
  const frozen = (await request('/api/claim-preview', 'GET')).data;
  assert.equal(frozen.patientCount, 1);
  const unchanged = (await request(previewUrl, 'GET')).data;
  assert.equal(unchanged.hasChanges, false);
  assert.equal((await finalize(unchanged)).status, 409);

  actor = editor;
  assert.equal((await edit(frozen.revision, 3)).status, 200);
  assert.equal((await request('/api/claim-preview', 'GET')).data.csv, frozen.csv);
  const corrected = (await request(previewUrl, 'GET')).data;
  assert.equal(corrected.hasChanges, true);
  assert.equal(corrected.previous.id, first.id);
  actor = confirmer;
  assert.equal((await finalize(corrected)).status, 400);
  const second = (await finalize(corrected, '算定数量の訂正')).data.claimRecord;
  assert.equal(second.version, 2);
  assert.equal(second.previousId, first.id);
  assert.equal(second.correctionReason, '算定数量の訂正');
  const updatedCsv = (await request('/api/claim-preview', 'GET')).data;
  assert.notEqual(updatedCsv.csv, frozen.csv);
  assert.equal((await request('/api/workspace', 'POST', command(updatedCsv.revision, { type: 'reset' }))).status, 200);
  api.close();

  const history = (await request(`/api/claim-records?q=${patient.chartNumber}`, 'GET')).data.records;
  assert.deepEqual(history.map(({ version }: { version: number }) => version), [2, 1]);
  assert.deepEqual((await request(`/api/claim-records?id=${first.id}`, 'GET')).data, first);
  assert.equal((await request('/api/claim-preview', 'GET')).data.csv, updatedCsv.csv);
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  assert.throws(() => db.exec("UPDATE claim_records SET body = '{}'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM claim_records'), /append-only/);
  assert.throws(() => db.exec('INSERT OR REPLACE INTO claim_records SELECT * FROM claim_records WHERE version = 1'),
    /appended/);
  assert.ok(readAccessAudit(db, 0, 100).some(({ event }) => event.claimRecordIds?.includes(first.id) &&
    event.operation === 'read-claim-record'));

  const backupFile = `${filename}.backup.sqlite3`;
  execFileSync('python3', ['-c', `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)`, filename, backupFile]);
  chmodSync(backupFile, 0o600);
  const restoredApi = createWorkspaceApi(() => openWorkspace(backupFile, true));
  t.after(restoredApi.close);
  const restoredRequest = requestApi(restoredApi);
  assert.deepEqual((await restoredRequest(`/api/claim-records?id=${first.id}`, 'GET')).data, first);
  assert.equal((await restoredRequest('/api/claim-preview', 'GET')).data.csv, updatedCsv.csv);

  db.exec("DROP TRIGGER claim_records_no_update; UPDATE claim_records SET body = '{}' WHERE version = 1");
  assert.equal((await request(`/api/claim-records?id=${first.id}`, 'GET')).status, 500);
});

test('claim confirmation rolls back with the access audit if logging fails', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename));
  t.after(api.close);
  const request = requestApi(api);
  const patientId = INITIAL_PATIENTS[0].id;
  const preview = (await request(`/api/claim-records?patientId=${patientId}`, 'GET')).data;
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_claim_audit BEFORE INSERT ON access_audit
    WHEN json_extract(NEW.payload, '$.operation') = 'finalize' AND json_extract(NEW.payload, '$.status') = 200
    BEGIN SELECT raise(ABORT, 'audit write failed'); END`);
  assert.equal((await request('/api/workspace', 'POST', command(preview.revision, {
    type: 'finalize', patientId, reviewHash: preview.reviewHash,
  }))).status, 500);
  assert.equal(db.prepare('SELECT count(*) AS count FROM claim_records').get()?.count, 0);
  assert.equal(db.prepare('SELECT revision FROM workspace').get()?.revision, preview.revision);
});


test('demo exports are blocked at the API unless enabled, with access denials and export requests audited', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename, false));
  t.after(api.close);
  const request = requestApi(api);
  const workspace = await request('/api/workspace', 'GET');
  assert.equal(workspace.data.dataExportsEnabled, false);
  assert.equal(workspace.headers['Cache-Control'], 'no-store');
  assert.equal(workspace.headers['X-Frame-Options'], 'DENY');
  assert.equal(workspace.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal((await request('/api/workspace', 'GET', undefined, undefined, 'same-site')).status, 403);
  assert.equal((await request('/api/workspace', 'GET', undefined, 'http://localhost:5173', 'same-origin')).status, 200);
  const patientId = workspace.data.patients[0].id;
  const preview = (await request(`/api/claim-records?patientId=${patientId}`, 'GET')).data;
  const saved = await request('/api/workspace', 'POST', command(preview.revision, {
    type: 'finalize', patientId, reviewHash: preview.reviewHash,
  }));
  assert.equal(saved.status, 200);
  const path = `/api/claim-records?id=${saved.data.claimRecord.id}`;
  assert.equal((await request(path, 'GET')).status, 200);
  assert.equal((await request(path + '&export=1', 'GET')).status, 403);
  assert.equal((await request('/api/claim-preview', 'GET')).status, 403);
  for (const type of ['exportCsv', 'snapshot'] as const) {
    const denied = await request('/api/workspace', 'POST', command(saved.data.workspace.revision, { type }));
    assert.equal(denied.status, 403);
    assert.equal(denied.data.workspace, undefined);
  }
  assert.equal((await request('/api/workspace', 'GET')).data.revision, saved.data.workspace.revision);

  api.close();
  const enabledApi = createWorkspaceApi(() => openWorkspace(filename, true));
  t.after(enabledApi.close);
  const enabledRequest = requestApi(enabledApi);
  assert.equal((await enabledRequest('/api/workspace', 'GET')).data.dataExportsEnabled, true);
  const exported = await enabledRequest(path + '&export=1', 'GET');
  assert.deepEqual(exported.data, saved.data.claimRecord);
  const db = new DatabaseSync(filename, { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(readAccessAudit(db, 0, 100).map(({ event }) => event)
    .filter(({ operation }) => operation === 'export-claim-record')
    .map(({ status, claimRecordIds }) => [status, claimRecordIds]),
  [[403, undefined], [200, [saved.data.claimRecord.id]]]);
});

test('the database and sidecars must be private regular files on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const filename = setup(t);
  const privateDir = join(filename, '..', 'private');
  const fresh = join(privateDir, 'workspace.sqlite3');
  execFileSync('python3', ['database/init.py', fresh]);
  assert.equal(statSync(privateDir).mode & 0o077, 0);
  assert.equal(statSync(fresh).mode & 0o077, 0);
  chmodSync(fresh, 0o644);
  assert.throws(() => openWorkspace(fresh), /起動ユーザーだけ/);
  chmodSync(fresh, 0o600);
  chmodSync(privateDir, 0o770);
  assert.throws(() => openWorkspace(fresh), /他のユーザーが書き込めない/);
  chmodSync(privateDir, 0o700);
  const alias = join(privateDir, 'alias.sqlite3');
  symlinkSync(fresh, alias);
  assert.throws(() => openWorkspace(alias), /リンクではない/);
  symlinkSync(filename, fresh + '-wal');
  assert.throws(() => openWorkspace(fresh), /リンクではない/);
});


test('backup CLI preserves committed WAL data, audit events, masters and claims across a separate restore', (t) => {
  const filename = setup(t);
  const store = openWorkspace(filename, true);
  const writer = new DatabaseSync(filename);
  t.after(() => { writer.close(); store.close(); });
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  const access = {
    requestId: 'backup-test', requestedAt: '2026-11-11T00:00:00.000Z',
    actor: { kind: 'anonymous' }, resource: 'workspace', operation: 'finalize',
  } as const;
  const patientId = INITIAL_PATIENTS[0].id;
  const review = store.previewConfirmation(patientId);
  const result = store.apply(command(review.revision, {
    type: 'finalize', patientId, reviewHash: review.reviewHash,
  }), access);
  const comment = Array<string>(30).fill('0');
  comment.splice(1, 6, 'C', '8', '10', '1', '0', '');
  comment[22] = '810000001';
  const master = store.masters.import(masterFileParams('c_20261110.csv', '2026-11-10'),
    Buffer.from(comment.map((field) => `"${field}"`).join(',') + '\r\n')).entry;
  assert.ok(statSync(filename + '-wal').size > 0);

  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', 'server/backupCli.ts', ...args], {
      env: { ...process.env, RECEPT_DB: filename }, encoding: 'utf8', stdio: 'pipe',
    }));
  const archive = join(dirname(filename), 'backup output');
  writer.exec('BEGIN IMMEDIATE; UPDATE workspace SET offline = 1 WHERE id = 1');
  const first = run('create', archive);
  writer.exec('COMMIT');
  const second = run('create', archive);
  assert.notEqual(first.generation, second.generation);
  assert.deepEqual(run('verify', first.generation), first);
  assert.equal(first.integrity.claimRecords, 1);
  assert.equal(first.integrity.auditCheckpoint.seq, 1);

  const restore = join(dirname(filename), 'restored.sqlite3');
  assert.equal(run('restore', first.generation, restore).restoredDatabase, restore);
  assert.throws(() => run('restore', first.generation, filename), /復元先が既に存在/);
  assert.throws(() => run('restore', first.generation, restore), /復元先が既に存在/);
  const orphaned = join(dirname(filename), 'orphaned.sqlite3');
  writeFileSync(orphaned + '-wal', '', { mode: 0o600 });
  assert.throws(() => run('restore', first.generation, orphaned), /DBの関連ファイル/);
  assert.equal(existsSync(orphaned), false);

  const restored = openWorkspace(restore, true);
  t.after(restored.close);
  assert.equal(store.read().isOfflineMode, true);
  assert.equal(restored.read().isOfflineMode, false);
  assert.equal(restored.read().revision, result.workspace.revision);
  assert.deepEqual(restored.masters.list().map((entry) => ({ ...entry })), [master]);
  assert.equal(restored.preview().csv, store.preview().csv);
  assert.equal(restored.previewConfirmation(patientId).previous?.id, result.claimRecord?.id);
  const audit = new DatabaseSync(restore, { readOnly: true });
  try {
    assert.deepEqual(verifyAccessAudit(audit), first.integrity.auditCheckpoint);
  } finally {
    audit.close();
  }

  const incomplete = join(archive, 'incomplete');
  mkdirSync(incomplete, { mode: 0o700 });
  assert.throws(() => run('verify', incomplete), /完了済みバックアップ/);

  const damaged = join(second.generation, 'recept.sqlite3');
  const manifestPath = join(second.generation, 'manifest.json');
  const damagedDb = new DatabaseSync(damaged);
  try {
    const trigger = damagedDb.prepare("SELECT sql FROM sqlite_schema WHERE name = 'claim_records_no_update'").get();
    damagedDb.exec("DROP TRIGGER claim_records_no_update; UPDATE claim_records SET sha256 = printf('%064d', 0)");
    damagedDb.exec(String(trigger?.sql));
  } finally {
    damagedDb.close();
  }
  const content = readFileSync(damaged);
  writeFileSync(manifestPath, JSON.stringify({
    ...second.manifest, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
  }));
  assert.throws(() => run('verify', second.generation), /確定記録の整合性/);
  appendFileSync(damaged, 'invalid');
  const rejected = join(dirname(filename), 'rejected.sqlite3');
  assert.throws(() => run('restore', second.generation, rejected), /サイズまたはSHA-256/);
  assert.equal(existsSync(rejected), false);
});


test('staff sessions enforce server-side roles, audit the verified user and are revoked on logout or disable', async (t) => {
  const filename = setup(t);
  const store = openWorkspace(filename, true);
  t.after(store.close);
  const receptionPassword = store.accounts.create('test-reception', 'reception');
  const physicianPassword = store.accounts.create('test-physician', 'physician');
  const adminPassword = store.accounts.create('test-admin', 'admin');
  const api = createAuthenticatedApi(() => openWorkspace(filename, true));
  t.after(api.close);
  const request = requestApi(api);
  for (const path of ['/api/workspace', '/api/claim-preview', '/api/claim-records', '/api/official-masters']) {
    assert.equal((await request(path, 'GET')).status, 401);
  }

  async function login(id: string, password: string) {
    const response = await request('/api/login', 'POST', { id, password }, 'http://localhost:5173', 'same-origin');
    assert.equal(response.status, 200);
    assert.match(response.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Max-Age=1800/);
    assert.equal(response.data.staff.id, id);
    assert.equal(response.data.password, undefined);
    return response.headers['Set-Cookie'].split(';')[0];
  }
  assert.equal((await request('/api/login', 'POST', { id: 'test-admin', password: 'wrong' })).status, 401);
  assert.equal((await request('/api/login', 'POST', { id: 'test-admin', password: adminPassword }, 'https://other.example')).status, 403);
  const clerk = await login('test-reception', receptionPassword);
  const doctor = await login('test-physician', physicianPassword);
  const admin = await login('test-admin', adminPassword);
  const use = (cookie: string, path: string, method = 'GET', value?: unknown) =>
    request(path, method, value, undefined, undefined, cookie);

  const workspace = await use(clerk, '/api/workspace');
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.data.activity, []);
  assert.equal(workspace.data.dataExportsEnabled, false);
  const patientId = workspace.data.patients[0].id;
  const claimPath = `/api/claim-records?patientId=${patientId}`;
  assert.equal((await use(clerk, claimPath)).status, 403);
  assert.equal((await use(clerk, '/api/workspace', 'POST', command(0, { type: 'reset' }))).status, 403);
  assert.equal((await use(clerk, '/api/workspace', 'POST', command(0, {
    type: 'register', patient: INITIAL_PATIENTS[0],
  }))).status, 403);
  assert.equal((await use(clerk, '/api/official-masters', 'POST', Buffer.from('demo'))).status, 403);
  assert.equal((await use(doctor, '/api/claim-preview')).status, 403);

  const doctorSession = (await use(doctor, '/api/session')).data;
  const staleTab = await request('/api/workspace', 'GET', undefined, undefined, undefined, admin, doctorSession.sessionId);
  assert.equal(staleTab.status, 401);
  assert.equal(staleTab.data.patients, undefined);
  const reviewed = (await use(doctor, claimPath)).data;
  const finalized = await use(doctor, '/api/workspace', 'POST', command(reviewed.revision, {
    type: 'finalize', patientId, reviewHash: reviewed.reviewHash,
  }));
  assert.equal(finalized.status, 200);
  assert.equal(finalized.data.claimRecord.confirmedBy.userId, 'test-physician');
  const detailPath = `/api/claim-records?id=${finalized.data.claimRecord.id}`;
  assert.equal((await use(doctor, detailPath)).status, 200);
  assert.equal((await use(doctor, detailPath + '&export=1')).status, 403);
  assert.equal((await use(admin, detailPath + '&export=1')).status, 200);
  assert.equal((await use(admin, '/api/claim-preview')).status, 200);

  assert.equal((await use(doctor, '/api/logout', 'POST', {})).status, 200);
  assert.equal((await use(doctor, '/api/workspace')).status, 401);
  store.accounts.disable('test-reception');
  assert.equal((await use(clerk, '/api/session')).status, 401);
  const changedPassword = store.accounts.reset('test-admin');
  assert.equal((await use(admin, '/api/session')).status, 401);
  const renewed = await login('test-admin', changedPassword);
  assert.equal((await use(renewed, '/api/session')).status, 200);
  api.close();
  assert.equal((await use(renewed, '/api/session')).status, 401);

  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const audit = readAccessAudit(db, 0, 100).map(({ event }) => event);
    assert.ok(audit.some(({ operation, actor }) => operation === 'logout' &&
      actor.kind === 'authenticated' && actor.userId === 'test-physician'));
    assert.ok(audit.some(({ operation, status, actor }) => operation === 'login' &&
      status === 200 && actor.kind === 'authenticated' && actor.userId === 'test-admin'));
    assert.ok(!JSON.stringify(audit).includes(adminPassword));
    assert.equal(db.prepare("SELECT length(password_hash) AS n FROM staff_accounts WHERE id = 'test-admin'").get()?.n, 32);
  } finally {
    db.close();
  }
});

test('staff session expires at 30 minutes even when the account is active', () => {
  let time = Date.parse('2026-11-11T00:00:00.000Z');
  const sessions = staffSessions(() => time);
  const req = { headers: {} } as IncomingMessage;
  const staff = { id: 'test-admin', role: 'admin' } as const;
  const session = sessions.create({ ...staff, version: 1 }, req);
  req.headers.cookie = `recept_session=${session.token}`;
  assert.equal(sessions.get(req, () => staff)?.staff, staff);
  time = session.expiresAt;
  assert.equal(sessions.get(req, () => staff), null);
});
