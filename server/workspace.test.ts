import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('workspace HTTP middleware serves JSON and rejects cross-origin or malformed writes', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename));
  t.after(api.close);
  function request(url: string, method: string, value?: unknown, origin?: string) {
    const raw = Buffer.isBuffer(value);
    const body = raw ? value : Buffer.from(JSON.stringify(value ?? null));
    const req = Object.assign(Readable.from(value === undefined ? [] : [body]), {
      url, method,
      headers: { host: 'localhost:5173', 'content-type': raw ? 'application/octet-stream' : 'application/json', origin },
      socket: { remoteAddress: '127.0.0.1' },
    });
    return new Promise<{ status: number; data: any }>((resolve, reject) => {
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; },
        end(body: string) { resolve({ status, data: JSON.parse(body) }); },
      };
      api.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => reject(new Error('Unexpected next()')));
    });
  }
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
});
