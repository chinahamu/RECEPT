import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { validateResponse } from '../integration/recept-v1/contract.mjs';
import { createWorkspaceApi } from './api';
import { readAccessAudit, verifyAccessAudit } from './accessAudit';
import { masterFileParams } from './officialMasters';
import { openWorkspace } from './workspace';

const fixtures = JSON.parse(readFileSync('integration/recept-v1/fixtures.json', 'utf8'));
const encode = (message: unknown) => JSON.stringify(message);

test('DENCAL intake deduplicates raw messages, holds exceptions and explicitly matches an existing patient', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recept-inbox-test-'));
  const filename = join(directory, 'recept.sqlite3');
  execFileSync('python3', ['database/init.py', filename]);
  const token = 'test-integration-key';
  const env = {
    RECEPT_DENCAL_TOKEN: token,
    RECEPT_DENCAL_FACILITY_ID: fixtures.source.facilityId as string,
    RECEPT_DENCAL_SENDER_ID: fixtures.source.senderId as string,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const store = openWorkspace(filename);
  const password = store.accounts.create('inbox-staff', 'reception');
  const adminPassword = store.accounts.create('inbox-admin', 'admin');
  const initial = store.read();
  const patient = initial.patients[0];
  const otherPatient = initial.patients[1];
  const row = (columns: number, fields: Record<number, string>) => Buffer.from(Object.assign(Array<string>(columns).fill('0'), fields).join(','));
  store.masters.import(masterFileParams('b_20261101.txt', '2026-11-01'), row(46, {
    1: 'B', 2: '9990001', 5: '架空傷病', 18: '00', 19: '0', 21: '20261101', 23: '99999999',
  }));
  const procedureFields = {
    1: 'S', 2: '199000001', 4: '架空診療行為', 9: '回', 10: '3', 11: '100', 12: '0',
    14: '600', 15: '0', 29: '0', 86: '20261101', 87: '99999999', 112: '',
  };
  const procedures = Buffer.concat([
    row(150, procedureFields), Buffer.from('\n'),
    row(150, { ...procedureFields, 2: '199000002', 4: '入院専用', 12: '1' }),
  ]);
  store.masters.import(masterFileParams('s_20261101.csv', '2026-11-01'), procedures);
  store.close();
  const open = () => openWorkspace(filename);
  let api = createWorkspaceApi(open);
  const server = createServer((req, res) => api.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const machine = '/api/integration/v1';
  const ui = '/api/integration/inbox';
  const authorization = { Authorization: 'Bearer ' + token };
  const send = (raw: string, headers: Record<string, string> = authorization) => fetch(origin + machine + '/encounters', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: raw,
  });
  async function login(id = 'inbox-staff', secret = password) {
    const response = await fetch(origin + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encode({ id, password: secret }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  function staff(path: string, cookie: string, body?: unknown) {
    return fetch(origin + path, {
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: encode(body) }),
    });
  }
  async function responseJson(response: Response, status: number) {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }

  const { initial: first, correction, unknown } = fixtures.messages;
  const bytes = encode(first);
  assert.equal((await send(bytes, {})).status, 401);
  assert.equal((await send(bytes, { ...authorization, Origin: origin })).status, 403);
  assert.equal((await send(encode({ ...first, senderId: 'outside' }))).status, 403);
  assert.equal((await fetch(origin + ui, { headers: authorization })).status, 401);
  const early = await responseJson(await send(encode(correction)), 202);
  assert.deepEqual(early.issues.map(({ code }: { code: string }) => code), ['predecessor_missing', 'patient_unmatched']);
  const accepted = await responseJson(await send(bytes), 202);
  assert.equal(validateResponse(accepted), true);
  assert.equal(accepted.bodySha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(accepted.issues, [{ code: 'patient_unmatched', path: '/patientId' }]);
  assert.deepEqual(await responseJson(await send(bytes), 200), accepted);
  assert.deepEqual(await responseJson(await send(bytes + '\n'), 409), { error: 'integration_id_conflict' });
  assert.deepEqual(await responseJson(await send(encode({ ...first, integrationId: 'new-id' })), 409), { error: 'transfer_revision_conflict' });

  const held = await responseJson(await send(encode(unknown)), 202);
  assert.ok(held.issues.some(({ code }: { code: string }) => code === 'unknown_master_code'));
  const unsupported = { ...first, integrationId: 'unsupported', encounterId: 'unsupported',
    performances: [{ ...first.performances[0], code: '199000002' }] };
  const heldUnsupported = await responseJson(await send(encode(unsupported)), 202);
  assert.ok(heldUnsupported.issues.some(({ code }: { code: string }) => code === 'unsupported_billing_rule'));
  const wrongUnit = { ...first, integrationId: 'wrong-unit', encounterId: 'wrong-unit',
    performances: [{ ...first.performances[0], unit: '錠' }] };
  const heldUnit = await responseJson(await send(encode(wrongUnit)), 202);
  assert.ok(heldUnit.issues.some(({ path }: { path: string }) => path === '/performances/0/unit'));

  const failedMessage = { ...first, integrationId: 'audit-failure', encounterId: 'audit-failure' };
  const auditDb = new DatabaseSync(filename);
  try {
    auditDb.exec(`CREATE TRIGGER test_fail_dencal_audit BEFORE INSERT ON access_audit
      WHEN json_extract(NEW.payload, '$.operation') = 'receive-dencal'
      BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`);
    assert.deepEqual(await responseJson(await send(encode(failedMessage)), 503), { error: 'temporarily_unavailable' });
    assert.equal(auditDb.prepare("SELECT 1 FROM dencal_inbox WHERE integration_id = 'audit-failure'").get(), undefined);
  } finally {
    auditDb.exec('DROP TRIGGER test_fail_dencal_audit');
    auditDb.close();
  }

  let cookie = await login();
  const page = await responseJson(await staff(ui, cookie), 200);
  assert.equal(page.records.length, 5);
  const entry = page.records.find(({ integrationId }: { integrationId: string }) => integrationId === first.integrationId);
  const detail = await responseJson(await staff(`${ui}/${entry.seq}`, cookie), 200);
  assert.equal(detail.patient, null);
  assert.equal(detail.performances[0].quantity, 1);
  const matchPath = `${ui}/${entry.seq}/match`;
  assert.equal((await staff(matchPath, cookie, { patientId: patient.id, chartNumber: 'wrong' })).status, 409);
  const matched = await responseJson(await staff(matchPath, cookie, { patientId: patient.id, chartNumber: patient.chartNumber }), 200);
  assert.equal(matched.patient.id, patient.id);
  assert.equal(matched.receipt.status, 'received');
  const stillHeld = await responseJson(await fetch(origin + machine + '/receipts/' + unknown.integrationId, { headers: authorization }), 200);
  assert.deepEqual(stillHeld.issues, [{ code: 'unknown_master_code', path: '/performances/0/code' }]);
  assert.equal((await staff(matchPath, cookie, { patientId: otherPatient.id, chartNumber: otherPatient.chartNumber })).status, 409);
  assert.deepEqual((await responseJson(await staff('/api/workspace', cookie), 200)).patients, initial.patients);

  api.close();
  api = createWorkspaceApi(open);
  cookie = await login();
  const receipt = await responseJson(await fetch(origin + machine + '/receipts/' + correction.integrationId, { headers: authorization }), 200);
  assert.equal(receipt.status, 'received');
  assert.deepEqual(receipt.issues, []);
  assert.equal((await responseJson(await staff(`${ui}/${entry.seq}`, cookie), 200)).patient.id, patient.id);

  // A different authenticated namespace cannot query the earlier sender's receipt.
  process.env.RECEPT_DENCAL_SENDER_ID = 'other-registered-sender';
  assert.equal((await fetch(origin + machine + '/receipts/' + first.integrationId, { headers: authorization })).status, 404);
  process.env.RECEPT_DENCAL_SENDER_ID = env.RECEPT_DENCAL_SENDER_ID;

  const admin = await login('inbox-admin', adminPassword);
  const current = await responseJson(await staff('/api/workspace', admin), 200);
  assert.equal((await staff('/api/workspace', admin, { revision: current.revision, action: { type: 'reset' } })).status, 200);
  const afterReset = await responseJson(await staff(`${ui}/${entry.seq}`, cookie), 200);
  assert.equal(afterReset.patient, null);
  assert.deepEqual(afterReset.receipt.issues, [{ code: 'patient_unmatched', path: '/patientId' }]);

  const db = new DatabaseSync(filename);
  try {
    assert.equal(db.prepare('SELECT count(*) AS total FROM dencal_inbox').get()?.total, 5);
    assert.ok(verifyAccessAudit(db).seq > 0);
    const events = readAccessAudit(db, 0, 100);
    assert.ok(events.some(({ event }) => event.actor.kind === 'integration' && event.duplicate === true));
    assert.ok(events.some(({ event }) => event.operation === 'match-dencal-patient' &&
      event.actor.kind === 'authenticated' && event.actor.userId === 'inbox-staff'));
    assert.doesNotMatch(JSON.stringify(events), /test-integration-key|実施数量を訂正/);
    assert.throws(() => db.exec('UPDATE dencal_inbox SET body_sha256 = body_sha256'), /immutable/);
  } finally { db.close(); }
});
