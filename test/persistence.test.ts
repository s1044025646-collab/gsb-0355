import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, Store } from '../src/db.js';
import { AuditService } from '../src/service.js';
import { DomainError } from '../src/domain.js';

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fts-'));
  return { dir, path: join(dir, 'audit.sqlite') };
}

test('重启后读取与代表选择得到相同精确结果；批次不可变；全部无效不发布估计', () => {
  const { dir, path } = tempDb();
  let store: Store | undefined;
  try {
    store = new Store(openDatabase(path));
    let svc = new AuditService(store);
    svc.createClockPair('p1', 'C', 'S');
    const imported = svc.importBatch(
      'p1',
      [
        { seq: '1', t1: '0', t2: '0', t3: '20', t4: '70' },
        { seq: '2', t1: '0', t2: '0', t3: '50', t4: '150' },
      ],
      { batchId: 'b1', sourceNote: '首轮' },
    );
    assert.equal(imported.batch.status, 'complete');
    assert.equal(imported.representative!.seq, '1');
    assert.equal(imported.usableOffsetEstimate!.offsetFraction, '-50/2');

    // 同 batchId 再次导入被拒
    assert.throws(
      () => svc.importBatch('p1', [{ seq: '1', t1: '0', t2: '0', t3: '0', t4: '0' }], { batchId: 'b1' }),
      (err: unknown) => err instanceof DomainError && err.code === 'BATCH_EXISTS',
    );

    // 模拟重启：重新打开同一数据库文件
    store.close();
    store = new Store(openDatabase(path));
    svc = new AuditService(store);
    const reloaded = svc.getReport('b1');
    assert.equal(reloaded.representative!.seq, '1');
    assert.equal(String(reloaded.representative!.offsetNumerator), '-50');
    assert.equal(String(reloaded.representative!.rtt), '50');
    assert.equal(reloaded.batch.ruleVersion, imported.ruleVersion);
    assert.equal(reloaded.batch.sourceNote, '首轮');

    // 全部无效批次：不发布估计
    const allBad = svc.importBatch('p1', [{ seq: '9', t1: '0', t2: '0', t3: '1000', t4: '500' }], {
      batchId: 'b-bad',
    });
    assert.equal(allBad.summary.allInvalid, true);
    assert.equal(allBad.usableOffsetEstimate, null);

    // 跨时钟对比较被拒绝
    svc.createClockPair('p2', 'C2', 'S2');
    svc.importBatch('p2', [{ seq: '1', t1: '0', t2: '0', t3: '0', t4: '0' }], { batchId: 'b2' });
    assert.throws(
      () => svc.compareBatches(['b1', 'b2']),
      (err: unknown) => err instanceof DomainError && err.code === 'PAIR_MISMATCH',
    );
  } finally {
    try {
      store?.close();
    } catch {
      // 忽略关闭异常
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 偶发句柄延迟，忽略清理错误
    }
  }
});
