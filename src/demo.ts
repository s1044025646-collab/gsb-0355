/**
 * 虚构合成数据。约定：服务端时钟 = 客户端时钟 + 真实偏移 θ；
 * T2 = T1 + θ + 下行时延；T4 = T3 - θ + 上行时延；T3 = T2 + 服务端处理时长。
 * 单位均为纳秒，全部为字符串。
 */

interface Four {
  seq: string;
  t1: string;
  t2: string;
  t3: string;
  t4: string;
}

function make(
  seq: number,
  t1: bigint,
  offset: bigint,
  down: bigint,
  processing: bigint,
  up: bigint,
): Four {
  const t2 = t1 + offset + down;
  const t3 = t2 + processing;
  const t4 = t3 - offset + up;
  return {
    seq: String(seq),
    t1: t1.toString(),
    t2: t2.toString(),
    t3: t3.toString(),
    t4: t4.toString(),
  };
}

/** 对称路径：上下行均 10000 ns，θ=+250000 ns，中点估计应精确等于 θ。 */
export function demoRecordsSymmetric(): Four[] {
  return [
    make(1, 1_000_000_000n, 250_000n, 10_000n, 5_000n, 10_000n),
    make(2, 2_000_000_000n, 250_000n, 10_000n, 50_000n, 10_000n),
    make(3, 3_000_000_000n, 250_000n, 10_000n, 12_000n, 10_000n),
  ];
}

/** 非对称路径：下行 30000、上行 5000；中点偏离真实 θ，但 θ 必在可行区间内。 */
export function demoRecordsAsymmetric(): Four[] {
  return [
    make(1, 1_000_000_000n, 250_000n, 30_000n, 8_000n, 5_000n),
    make(2, 2_000_000_000n, 250_000n, 30_000n, 4_000n, 5_000n),
  ];
}

/** 异常与边界集合。 */
export function demoRecordsNegative(): unknown[] {
  const valid = [
    // #1 零网络时延、负偏移 θ=-100000，处理 3000：T2=T1-100000，T4=T3+100000
    make(1, 5_000_000_000n, -100_000n, 0n, 3_000n, 0n),
    // #2 半纳秒偏移：直接构造奇数分子 ((T2-T1)+(T3-T4))=1
    { seq: '2', t1: '1000', t2: '1001', t3: '2000', t4: '2000' },
    // #3 超过 Number.MAX_SAFE_INTEGER 的 18 位时间戳（对称，θ=0）
    make(3, 9_007_199_254_740_993_000n, 0n, 7_000n, 9_000n, 7_000n),
    // #1 同编号同内容：幂等接受
    make(1, 5_000_000_000n, -100_000n, 0n, 3_000n, 0n),
    // #1 同编号冲突内容：拒绝 SEQ_CONFLICT
    { seq: '1', t1: '5000000000', t2: '1', t3: '2', t4: '3' },
  ];
  const invalid = [
    // #4 T4 早于 T1
    { seq: '4', t1: '2000', t2: '2100', t3: '2200', t4: '1900' },
    // #5 负网络时延（客户端耗时 < 服务端处理时长）
    { seq: '5', t1: '0', t2: '0', t3: '1000', t4: '500' },
    // #6 非数字
    { seq: '6', t1: 'abc', t2: '0', t3: '0', t4: '0' },
  ];
  return [...valid, ...invalid];
}
