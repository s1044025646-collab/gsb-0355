import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBatch, fractionToApproxNumber } from '../src/domain.js';

test('对称路径：中点估计等于真实偏移，处理时长不计入 RTT', () => {
  const r = evaluateBatch([
    // θ=250000, down=10000, proc=5000, up=10000
    { seq: '1', t1: '1000000000', t2: '1000260000', t3: '1000265000', t4: '1000025000' },
  ]);
  assert.equal(r.invalid.length, 0);
  const e = r.results[0]!;
  assert.equal(e.clientElapsed, '25000');
  assert.equal(e.serverProcessing, '5000');
  assert.equal(e.rtt, '20000');
  assert.equal(e.offsetNumerator, '500000');
  assert.equal(e.offsetDenominator, '2');
  assert.equal(e.offsetApproxNanoseconds, 250000);
  assert.equal(e.boundLower, '240000');
  assert.equal(e.boundUpper, '260000');
});

test('非对称路径：真实偏移落在区间内，中点不等于真实偏移', () => {
  const r = evaluateBatch([
    // θ=250000, down=30000, up=5000: T2-T1=280000, T3-T4=245000
    { seq: '1', t1: '1000000000', t2: '1000280000', t3: '1000288000', t4: '1000043000' },
  ]);
  const e = r.results[0]!;
  assert.equal(e.boundLower, '245000');
  assert.equal(e.boundUpper, '280000');
  // 250000 在 [245000, 280000] 内
  assert.ok(250000n >= BigInt(e.boundLower) && 250000n <= BigInt(e.boundUpper));
  assert.equal(e.offsetApproxNanoseconds, 262500); // 中点偏离 250000
  assert.equal(e.rtt, '35000');
});

test('半纳秒偏移保留精确分数 1/2，不被整数除二截断', () => {
  // T2-T1 = 1, T3-T4 = 0 => 分子 = 1 => offset = 1/2 ns；RTT = 1
  const r = evaluateBatch([{ seq: '2', t1: '1000', t2: '1001', t3: '2000', t4: '2000' }]);
  const e = r.results[0]!;
  assert.equal(e.offsetNumerator, '1');
  assert.equal(e.offsetDenominator, '2');
  assert.equal(fractionToApproxNumber({ numerator: 1n, denominator: 2n }), 0.5);
  assert.equal(e.rtt, '1');
});

test('超过安全整数的时间戳按 BigInt 精确核算', () => {
  const t1 = 9_007_199_254_740_993_000n;
  const r = evaluateBatch([
    {
      seq: '3',
      t1: t1.toString(),
      t2: (t1 + 7000n).toString(),
      t3: (t1 + 16000n).toString(),
      t4: (t1 + 23000n).toString(),
    },
  ]);
  const e = r.results[0]!;
  assert.equal(e.offsetNumerator, '0');
  assert.equal(e.rtt, '14000');
});

test('零网络延迟与负偏移合法，跨时钟 T2 早于 T1 不判非法', () => {
  const r = evaluateBatch([{ seq: '1', t1: '5000000000', t2: '4999900000', t3: '4999903000', t4: '5000003000' }]);
  const e = r.results[0]!;
  assert.equal(e.valid, true);
  assert.equal(e.rtt, '0');
  assert.equal(e.offsetApproxNanoseconds, -100000);
});

test('T4 早于 T1 与负 RTT 单独列出原因', () => {
  const r = evaluateBatch([
    { seq: '4', t1: '2000', t2: '2100', t3: '2200', t4: '1900' },
    { seq: '5', t1: '0', t2: '0', t3: '1000', t4: '500' },
  ]);
  assert.deepEqual(r.results[0]!.reasons, ['T4_BEFORE_T1', 'NEGATIVE_RTT']);
  assert.deepEqual(r.results[1]!.reasons, ['NEGATIVE_RTT']);
  assert.equal(r.allInvalid, true);
  assert.equal(r.representative, null);
});

test('代表样本取最小 RTT；平局按编号升序；失败记录不参与', () => {
  const r = evaluateBatch([
    { seq: '3', t1: '0', t2: '0', t3: '50', t4: '150' }, // rtt 100
    { seq: '2', t1: '0', t2: '0', t3: '0', t4: '50' }, // rtt 50
    { seq: '1', t1: '0', t2: '0', t3: '20', t4: '70' }, // rtt 50
    { seq: '9', t1: '0', t2: '0', t3: '1000', t4: '500' }, // 负 rtt，无效
  ]);
  assert.equal(r.representative!.seq, '1');
  assert.match(r.representativeBasis!, /1, 2/);
});

test('同编号同内容幂等，冲突内容拒绝', () => {
  const rec = { seq: '1', t1: '1', t2: '2', t3: '3', t4: '4' };
  const r = evaluateBatch([
    rec,
    { ...rec },
    { seq: '1', t1: '1', t2: '9', t3: '3', t4: '4' },
  ]);
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.invalid[0]!.reasons, ['SEQ_CONFLICT']);
});

test('四戳同平移保持全部差值；仅平移服务端两戳则偏移平移、RTT 不变', () => {
  const base = evaluateBatch([{ seq: '1', t1: '1000', t2: '1100', t3: '1200', t4: '1300' }]).results[0]!;
  const all = evaluateBatch([{ seq: '1', t1: '2000', t2: '2100', t3: '2200', t4: '2300' }]).results[0]!;
  for (const key of ['clientElapsed', 'serverProcessing', 'rtt', 'offsetNumerator', 'boundLower', 'boundUpper'] as const) {
    assert.equal(all[key], base[key], key);
  }
  const serverShifted = evaluateBatch([{ seq: '1', t1: '1000', t2: '1600', t3: '1700', t4: '1300' }]).results[0]!;
  assert.equal(serverShifted.rtt, base.rtt);
  assert.equal(BigInt(serverShifted.offsetNumerator), BigInt(base.offsetNumerator) + 1000n);
});

test('非数字记录进入非法列表', () => {
  const r = evaluateBatch([{ seq: '6', t1: 'abc', t2: '0', t3: '0', t4: '0' }]);
  assert.equal(r.results.length, 0);
  assert.deepEqual(r.invalid[0]!.reasons, ['VALIDATION_ERROR']);
});
