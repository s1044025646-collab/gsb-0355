import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/db";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clock-")), "test.db");
}

const RECS = [
  { seq: 0, t1: "1000", t2: "1200", t3: "1250", t4: "1400" }, // rtt 350
  { seq: 1, t1: "2000", t2: "2150", t3: "2160", t4: "2160" }, // rtt 150
  { seq: 2, t1: "3000", t2: "3150", t3: "3160", t4: "3160" }, // rtt 150 平局，编号大
];

test("幂等导入与同编号冲突拒绝", () => {
  const s = new Store(":memory:");
  const pair = s.createPair("c", "s");
  const batch = s.createBatch(pair.pairId);
  const r1 = s.importRecords(batch.batchId, [RECS[0]]);
  assert.deepEqual(r1.accepted, [0]);
  const r2 = s.importRecords(batch.batchId, [RECS[0]]); // 同内容幂等
  assert.deepEqual(r2.duplicates, [0]);
  const r3 = s.importRecords(batch.batchId, [{ ...RECS[0], t4: "1401" }]); // 冲突
  assert.equal(r3.conflicts.length, 1);
  assert.equal(r3.conflicts[0].code, "SEQ_CONFLICT");
  s.close();
});

test("非法记录单独列出且不参与代表选择；平局按编号", () => {
  const s = new Store(":memory:");
  const pair = s.createPair("c", "s");
  const batch = s.createBatch(pair.pairId);
  const bad = { seq: 9, t1: "0", t2: "5", t3: "100", t4: "50" }; // NEGATIVE_RTT
  const res = s.importRecords(batch.batchId, [...RECS, bad]);
  assert.equal(res.invalid.length, 1);
  assert.equal(res.invalid[0].code, "NEGATIVE_RTT");
  const report = s.finalizeBatch(batch.batchId);
  assert.equal(report.validCount, 3);
  assert.equal(report.invalidCount, 1);
  assert.equal(report.representative!.seq, 1); // 平局取小编号
  assert.match(report.representative!.reason, /平局/);
  s.close();
});

test("全部无效时不发布可用偏移估计", () => {
  const s = new Store(":memory:");
  const pair = s.createPair("c", "s");
  const batch = s.createBatch(pair.pairId);
  s.importRecords(batch.batchId, [{ seq: 0, t1: "0", t2: "5", t3: "100", t4: "50" }]);
  const report = s.finalizeBatch(batch.batchId);
  assert.equal(report.validCount, 0);
  assert.equal(report.representative, null);
  assert.throws(() => s.representative(batch.batchId), /无有效记录/);
  s.close();
});

test("完成后批次只读；重启后查询结果一致（持久化冻结）", () => {
  const file = tmpDb();
  let s = new Store(file);
  const pair = s.createPair("c", "s");
  const batch = s.createBatch(pair.pairId);
  s.importRecords(batch.batchId, RECS);
  const before = s.finalizeBatch(batch.batchId);
  assert.throws(() => s.importRecords(batch.batchId, RECS), /BATCH_FINALIZED|已完成/);
  s.close();
  // 模拟重启
  s = new Store(file);
  const after = s.report(batch.batchId);
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.representative, before.representative);
  const rep = s.representative(batch.batchId);
  assert.equal(rep.record.offset2, before.records[1].offset2);
  s.close();
});

test("修改输入产生新批次，旧报告仍按原数据核算", () => {
  const s = new Store(":memory:");
  const pair = s.createPair("c", "s");
  const b1 = s.createBatch(pair.pairId);
  s.importRecords(b1.batchId, [RECS[0]]);
  const r1 = s.finalizeBatch(b1.batchId);
  const b2 = s.createBatch(pair.pairId);
  s.importRecords(b2.batchId, [{ ...RECS[0], t4: "1500" }]);
  const r2 = s.finalizeBatch(b2.batchId);
  assert.notEqual(r1.records[0].rtt, r2.records[0].rtt);
  assert.equal(s.report(b1.batchId).records[0].rtt, r1.records[0].rtt); // 旧报告不变
  const cmp = s.compareBatches(b1.batchId, b2.batchId);
  assert.equal(cmp.sameClockPair, true);
  assert.ok(cmp.offset2Diff !== null);
  s.close();
});

test("导出包含原时间戳与规则版本", () => {
  const s = new Store(":memory:");
  const pair = s.createPair("c", "s");
  const batch = s.createBatch(pair.pairId);
  s.importRecords(batch.batchId, RECS);
  s.finalizeBatch(batch.batchId);
  const exp = s.exportBatch(batch.batchId);
  assert.equal(exp.format, "clock-offset-export");
  assert.equal(exp.batch.ruleVersion, "v1");
  assert.equal(exp.rawRecords.length, 3);
  assert.equal(exp.rawRecords[0].t1, RECS[0].t1);
  s.close();
});
