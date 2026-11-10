import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { INITIAL_PATIENTS } from '../src/data/mhlwMaster';
import type { WorkspaceAction } from '../src/types/workspace';
import { createWorkspaceApi } from './api';
import { requestSchema } from './validation';
import { openWorkspace, WorkspaceError } from './workspace';

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
      type: 'register', patient: { ...INITIAL_PATIENTS[0], name: '架空 登録' },
    })).workspace;
    const newPatient = registered.patients[0];
    assert.equal(newPatient.name, '架空 登録');
    assert.notEqual(newPatient.id, INITIAL_PATIENTS[0].id);
    assert.equal(registered.activity[0].actionType, 'PATIENT_REGISTER');

    const firstItem = newPatient.billingItems[0];
    const modifiedItems = newPatient.billingItems.map((item) =>
      item.id === firstItem.id ? { ...item, quantity: 2, points: 99_999, commentText: '保存確認' } : item);
    const updated = store.apply(command(registered.revision, {
      type: 'update', patientId: newPatient.id, diagnoses: newPatient.diagnoses,
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
    assert.equal(state.patients[0].diagnoses.length, INITIAL_PATIENTS[0].diagnoses.length);
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
  const patient = initial.patients[0];
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

test('legacy browser data can be imported once into a fresh SQLite workspace', (t) => {
  const store = openWorkspace(setup(t));
  t.after(store.close);
  const legacy: WorkspaceAction = {
    type: 'importLegacy',
    patients: INITIAL_PATIENTS,
    activity: [{
      id: 'previous-activity', timestamp: '2026/11/10 10:00:00', actionType: 'BILLING_UPDATE',
      patientChartNumber: INITIAL_PATIENTS[0].chartNumber, summary: '旧版で編集',
    }],
    isOfflineMode: true,
  };
  const result = store.apply(command(0, legacy)).workspace;
  assert.deepEqual(result.activity, legacy.activity);
  assert.equal(result.isOfflineMode, true);
  assert.throws(() => store.apply(command(result.revision, legacy)),
    (error) => error instanceof WorkspaceError && error.status === 409);
});

test('workspace HTTP middleware serves JSON and rejects cross-origin or malformed writes', async (t) => {
  const filename = setup(t);
  const api = createWorkspaceApi(() => openWorkspace(filename));
  t.after(api.close);
  function request(url: string, method: string, value?: unknown, origin?: string) {
    const req = Object.assign(Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]), {
      url, method,
      headers: { host: 'localhost:5173', 'content-type': 'application/json', origin },
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
});
