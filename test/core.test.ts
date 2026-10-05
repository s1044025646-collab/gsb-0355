import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatOffsetExact,
  selectRepresentative,
  validateExchange,
} from "../src/core";

// 独立核对公式：offset = ((T2-T1)+(T3-T4))/2，rtt = (T4-T1)-(T3-T2)
function independent(t1: bigint, t2: bigint, t3: bigint, t4: bigint) {
  return { offset2: (t2 - t1) + (t3 - t4), rtt: t4 - t1 - (t3 - t2) };
}

test("公式独立核对：对称路径中点等于真实偏移", () => {
  // 真实偏移 +1000ns（服务端快），处理 50ns，上下行各 200ns
  const t1 = 1_000_000n, off = 1000n, up = 200n, down = 200n, proc = 50n;
  const t2 = t1 + up + off;
  const t3 = t2 + proc;
  const t4 = t3 + down - off;
  const v = validateExchange({ seq: 0, t1: `${t1}`, t2: `${t2}`, t3: `${t3}`, t4: `${t4}` });
  const exp = independent(t1, t2, t3, t4);
  assert.equal(v.valid, true);
  assert.equal(v.offset2, exp.offset2.toString());
  assert.equal(v.rtt, exp.rtt.toString());
  assert.equal(v.offset2, (2n * off).toString()); // 中点 == 真实偏移
  assert.equal(v.rtt, (up + down).toString()); // 不含处理时间
  assert.equal(v.serverProcessing, "50");
});

test("不对称路径：真实偏移落在可行区间内，中点有偏差", () => {
  const t1 = 0n, off = 500n, up = 300n, down = 100n, proc = 20n;
  const t2 = t1 + up + off;
  const t3 = t2 + proc;
  const t4 = t3 + down - off;
  const v = validateExchange({ seq: 1, t1: `${t1}`, t2: `${t2}`, t3: `${t3}`, t4: `${t4}` });
  assert.equal(v.valid, true);
  const lower = BigInt(v.offsetLower!), upper = BigInt(v.offsetUpper!);
  assert.ok(lower <= off && off <= upper, "真实偏移必须在区间内");
  const mid2 = BigInt(v.offset2!);
  assert.notEqual(mid2, 2n * off, "不对称时中点偏离真实偏移");
  assert.equal(mid2, lower + upper); // 中点即区间中点的 2 倍
});

test("零网络延迟", () => {
  const v = validateExchange({ seq: 2, t1: "100", t2: "105", t3: "105", t4: "100" });
  assert.equal(v.valid, true);
  assert.equal(v.rtt, "0");
  assert.equal(v.offset2, "10"); // 偏移 5ns
});

test("服务端负偏移", () => {
  // 服务端慢 40ns：T2 = T1 + 10 - 40，T4 = T3 + 10 + 40
  const v = validateExchange({ seq: 3, t1: "1000", t2: "970", t3: "975", t4: "1025" });
  assert.equal(v.valid, true);
  assert.equal(v.offset2, "-80");
  assert.equal(formatOffsetExact(v.offset2!), "-40 ns");
});

test("超过安全整数的时间戳", () => {
  const big = "900719925474099312345"; // > Number.MAX_SAFE_INTEGER
  const t1 = BigInt(big);
  const v = validateExchange({
    seq: 4,
    t1: big,
    t2: (t1 + 300n).toString(),
    t3: (t1 + 350n).toString(),
    t4: (t1 + 500n).toString(),
  });
  assert.equal(v.valid, true);
  assert.equal(v.rtt, "450");
  assert.equal(v.offset2, "150"); // (t2-t1)=300, (t3-t4)=-150
});

test("奇数半纳秒结果以分数精确保存", () => {
  // (t2-t1)=1, (t3-t4)=0 => offset2=1 => 1/2 ns
  const v = validateExchange({ seq: 5, t1: "10", t2: "11", t3: "12", t4: "12" });
  assert.equal(v.valid, true);
  assert.equal(v.offset2, "1");
  assert.equal(formatOffsetExact("1"), "1/2 ns");
  assert.equal(formatOffsetExact("-3"), "-3/2 ns");
  assert.equal(formatOffsetExact("4"), "2 ns");
});

test("负网络时延判非法", () => {
  const v = validateExchange({ seq: 6, t1: "0", t2: "5", t3: "100", t4: "50" });
  assert.equal(v.valid, false);
  assert.equal(v.errorCode, "NEGATIVE_RTT");
});

test("T4 早于 T1 / T3 早于 T2 判非法；跨时钟 T2<T1 合法", () => {
  assert.equal(validateExchange({ seq: 7, t1: "10", t2: "0", t3: "0", t4: "5" }).errorCode, "T4_BEFORE_T1");
  assert.equal(validateExchange({ seq: 8, t1: "0", t2: "10", t3: "5", t4: "20" }).errorCode, "T3_BEFORE_T2");
  // 服务端时钟大幅落后：T2 < T1 但数据合法
  const v = validateExchange({ seq: 9, t1: "1000000", t2: "10", t3: "15", t4: "1000020" });
  assert.equal(v.valid, true);
});

test("非法时间戳格式与位数上限", () => {
  assert.equal(validateExchange({ seq: 10, t1: "1.5", t2: "0", t3: "0", t4: "0" }).errorCode, "INVALID_TIMESTAMP");
  assert.equal(validateExchange({ seq: 11, t1: "1".repeat(31), t2: "0", t3: "0", t4: "0" }).errorCode, "INVALID_TIMESTAMP");
  assert.equal(validateExchange({ seq: 12, t1: "1".repeat(30), t2: "0", t3: "0", t4: "0" }).errorCode, "T4_BEFORE_T1"); // 30 位合法
});

test("四戳同时平移保持全部差值；只平移服务端两戳则偏移平移、时延不变", () => {
  const base = { t1: 1000n, t2: 1200n, t3: 1250n, t4: 1400n };
  const k = 7_777_777n;
  const a = validateExchange({ seq: 13, t1: `${base.t1}`, t2: `${base.t2}`, t3: `${base.t3}`, t4: `${base.t4}` });
  const b = validateExchange({
    seq: 14,
    t1: `${base.t1 + k}`, t2: `${base.t2 + k}`, t3: `${base.t3 + k}`, t4: `${base.t4 + k}`,
  });
  assert.equal(a.offset2, b.offset2);
  assert.equal(a.rtt, b.rtt);
  assert.equal(a.clientTotal, b.clientTotal);
  assert.equal(a.serverProcessing, b.serverProcessing);
  // 只平移服务端两戳：相当于服务端时钟多偏 k
  const c = validateExchange({
    seq: 15,
    t1: `${base.t1}`, t2: `${base.t2 + k}`, t3: `${base.t3 + k}`, t4: `${base.t4}`,
  });
  assert.equal(BigInt(c.offset2!) - BigInt(a.offset2!), 2n * k);
  assert.equal(c.rtt, a.rtt);
});

test("代表样本：最小时延，平局按编号升序", () => {
  const rep = selectRepresentative([
    { seq: 5, rtt: "100", offset2: "10" },
    { seq: 2, rtt: "100", offset2: "20" },
    { seq: 9, rtt: "300", offset2: "30" },
  ]);
  assert.equal(rep!.seq, 2);
  assert.match(rep!.reason, /平局/);
  assert.equal(selectRepresentative([]), null);
});
