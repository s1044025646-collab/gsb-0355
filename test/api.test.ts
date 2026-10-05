import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, Store } from '../src/db.js';
import { AuditService } from '../src/service.js';
import { createApp, listen } from '../src/server.js';
import { Server } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'fts-api-'));
const dbPath = join(dir, 'api.sqlite');
const service = new AuditService(new Store(openDatabase(dbPath)));
const server: Server = createApp(service);
const port = await listen(server, 0);
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  service.store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test('健康检查', async () => {
  const { status, json } = await call('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('完整 API 流程：创建对、导入、报告、比较、错误码', async () => {
  const created = await call('POST', '/api/pairs', { pairId: 'api-pair', clientLabel: 'C', serverLabel: 'S' });
  assert.equal(created.status, 200);

  const dup = await call('POST', '/api/pairs', { pairId: 'api-pair', clientLabel: 'C', serverLabel: 'S' });
  assert.equal(dup.status, 409);
  assert.equal((dup.json.error as { code: string }).code, 'PAIR_EXISTS');

  const imported = await call('POST', '/api/pairs/api-pair/batches', {
    batchId: 'api-b1',
    records: [
      { seq: '1', t1: '0', t2: '0', t3: '20', t4: '70' },
      { seq: '2', t1: '0', t2: '0', t3: '0', t4: '100' },
    ],
  });
  assert.equal(imported.status, 200);
  assert.equal((imported.json.representative as { seq: string }).seq, '1');

  const badJson = await fetch(`http://127.0.0.1:${port}/api/pairs/api-pair/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badJson.status, 400);

  await call('POST', '/api/pairs/api-pair/batches', {
    batchId: 'api-b2',
    records: [{ seq: '1', t1: '0', t2: '5', t3: '10', t4: '20' }],
  });

  const report = await call('GET', '/api/batches/api-b1');
  assert.equal(report.status, 200);
  assert.equal((report.json.exchanges as unknown[]).length, 2);

  const compare = await call('POST', '/api/compare', { batchIds: ['api-b1', 'api-b2'] });
  assert.equal(compare.status, 200);
  assert.equal((compare.json.batches as unknown[]).length, 2);

  const missing = await call('GET', '/api/batches/nope');
  assert.equal(missing.status, 404);
  assert.equal((missing.json.error as { code: string }).code, 'BATCH_NOT_FOUND');

  const unknownRoute = await call('GET', '/nope');
  assert.equal(unknownRoute.status, 404);
});
