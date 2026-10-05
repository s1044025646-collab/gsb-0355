// 核心核算逻辑：四时间戳时钟偏移与往返时延（全部使用 BigInt 精确计算）。
//
// 记客户端发送 T1、服务端接收 T2、服务端发送 T3、客户端接收 T4（单位：纳秒）。
// 偏移估计（服务端相对客户端）：offset = ((T2-T1) + (T3-T4)) / 2
// 网络往返时延：rtt = (T4-T1) - (T3-T2)   （不含服务端处理时间 T3-T2）
// 真实偏移可行区间（等速时钟、单向传播非负）：[T3-T4, T2-T1]
// 中点估计依赖上下行路径对称假设；不对称时中点可能有偏差。

export const RULE_VERSION = "v1";
export const MAX_DIGITS = 30; // 时间戳十进制位数上限
export const MAX_RECORDS_PER_BATCH = 10000; // 单批次记录数上限

export interface ExchangeInput {
  seq: number;
  t1: string;
  t2: string;
  t3: string;
  t4: string;
}

export type RecordErrorCode =
  | "INVALID_SEQ"
  | "INVALID_TIMESTAMP"
  | "T4_BEFORE_T1"
  | "T3_BEFORE_T2"
  | "NEGATIVE_RTT";

export interface RecordVerdict {
  seq: number;
  valid: boolean;
  errorCode?: RecordErrorCode;
  errorMessage?: string;
  // 以下字段仅在 valid 时存在，均为十进制整数字符串（纳秒）
  clientTotal?: string; // T4-T1 客户端总耗时
  serverProcessing?: string; // T3-T2 服务端处理时间
  rtt?: string; // 网络往返时延
  offset2?: string; // 2 倍偏移（半纳秒整数单位，避免分数精度丢失）
  offsetLower?: string; // 可行区间下界 T3-T4
  offsetUpper?: string; // 可行区间上界 T2-T1
}

const TIMESTAMP_RE = /^-?\d+$/;

export function parseTimestamp(value: unknown): { ok: true; v: bigint } | { ok: false } {
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) return { ok: false };
  const digits = value.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_DIGITS) return { ok: false };
  return { ok: true, v: BigInt(value) };
}

export function validateExchange(input: ExchangeInput): RecordVerdict {
  const { seq } = input;
  if (!Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER) {
    return { seq: Number.isInteger(seq) ? (seq as number) : -1, valid: false, errorCode: "INVALID_SEQ", errorMessage: "记录编号必须为非负安全整数" };
  }
  const ts: bigint[] = [];
  for (const key of ["t1", "t2", "t3", "t4"] as const) {
    const p = parseTimestamp(input[key]);
    if (!p.ok) {
      return { seq, valid: false, errorCode: "INVALID_TIMESTAMP", errorMessage: `时间戳 ${key} 必须为不超过 ${MAX_DIGITS} 位的十进制整数字符串` };
    }
    ts.push(p.v);
  }
  const [t1, t2, t3, t4] = ts;
  if (t4 < t1) {
    return { seq, valid: false, errorCode: "T4_BEFORE_T1", errorMessage: "T4 早于 T1：客户端接收早于客户端发送" };
  }
  if (t3 < t2) {
    return { seq, valid: false, errorCode: "T3_BEFORE_T2", errorMessage: "T3 早于 T2：服务端发送早于服务端接收" };
  }
  // 注意：T2 与 T1、T3 与 T4 属于不同时钟，跨时钟比较不用于判非法。
  const clientTotal = t4 - t1;
  const serverProcessing = t3 - t2;
  const rtt = clientTotal - serverProcessing;
  if (rtt < 0n) {
    return { seq, valid: false, errorCode: "NEGATIVE_RTT", errorMessage: "网络往返时延为负：(T4-T1) < (T3-T2)" };
  }
  const offset2 = (t2 - t1) + (t3 - t4); // 2 倍偏移，保持半纳秒精度
  return {
    seq,
    valid: true,
    clientTotal: clientTotal.toString(),
    serverProcessing: serverProcessing.toString(),
    rtt: rtt.toString(),
    offset2: offset2.toString(),
    offsetLower: (t3 - t4).toString(),
    offsetUpper: (t2 - t1).toString(),
  };
}

/** 将 2 倍偏移格式化为精确分数字符串，如 "5/2 ns" 或 "3 ns" */
export function formatOffsetExact(offset2: string): string {
  const v = BigInt(offset2);
  if (v % 2n === 0n) return `${v / 2n} ns`;
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  return `${sign}${a}/2 ns`;
}

/** 近似值（仅供显示，不参与任何计算与存储判定） */
export function formatOffsetApprox(offset2: string): string {
  return `${Number(BigInt(offset2)) / 2} ns`;
}

export interface RepresentativeSelection {
  seq: number;
  rtt: string;
  offset2: string;
  reason: string;
}

/** 代表样本：有效记录中往返时延最小者；平局按记录编号升序取先。 */
export function selectRepresentative(valid: Array<{ seq: number; rtt: string; offset2: string }>): RepresentativeSelection | null {
  if (valid.length === 0) return null;
  let best = valid[0];
  for (const r of valid) {
    const d = BigInt(r.rtt);
    const bd = BigInt(best.rtt);
    if (d < bd || (d === bd && r.seq < best.seq)) best = r;
  }
  const ties = valid.filter((r) => r.rtt === best.rtt).map((r) => r.seq);
  const reason =
    ties.length > 1
      ? `最小往返时延 ${best.rtt} ns 出现平局（编号 ${ties.join(", ")}），按记录编号升序取 ${best.seq}`
      : `有效记录中往返时延最小（${best.rtt} ns）`;
  return { seq: best.seq, rtt: best.rtt, offset2: best.offset2, reason };
}
