/**
 * 四时间戳时钟偏移与往返时延核算 —— 纯领域逻辑
 *
 * 规则版本 RULE_VERSION 随结果一起冻结入库；公式或判定规则变更时必须提升版本号。
 * 所有时间戳以纳秒十进制整数字符串输入，内部全程使用 bigint，绝不先转为 Number。
 */

export const RULE_VERSION = 'four-ts-v1';
export const TIME_UNIT = 'nanoseconds';

/** 时间戳允许的最大十进制位数（不含正负号），远大于 Number.MAX_SAFE_INTEGER 的 16 位。 */
export const MAX_TS_DIGITS = 24;
/** 编号允许的最大十进制位数。 */
export const MAX_SEQ_DIGITS = 18;
/** 单批次记录上限。 */
export const MAX_RECORDS_PER_BATCH = 10_000;

const INT_RE = /^-?\d+$/;

/** 精确分数：偏移可能为半纳秒，分母恒为 2，但以一般分数形式存储以便比较与展示。 */
export interface Fraction {
  numerator: bigint;
  denominator: bigint; // 恒正
}

export interface RawExchange {
  /** 记录编号（同一批次内唯一），十进制正整数字符串。 */
  seq: string;
  t1: string;
  t2: string;
  t3: string;
  t4: string;
}

export interface InvalidEntry {
  seq: string;
  reasons: string[];
  t1?: string;
  t2?: string;
  t3?: string;
  t4?: string;
}

export interface ExchangeResult extends RawExchange {
  valid: boolean;
  reasons: string[];
  /** 客户端观测总耗时 T4-T1（纳秒整数）。 */
  clientElapsed: string;
  /** 服务端处理时长 T3-T2（纳秒整数），不计入网络往返。 */
  serverProcessing: string;
  /** 往返网络时延 (T4-T1)-(T3-T2)。 */
  rtt: string;
  /** 偏移分数分子（半纳秒整数单位下即此值）。 */
  offsetNumerator: string;
  /** 偏移分数分母（本规则版本恒为 2）。 */
  offsetDenominator: string;
  /** 偏移近似值（纳秒，浮点，仅供展示，不参与任何核算）。 */
  offsetApproxNanoseconds: number;
  /** 真实偏移可行区间下界 T3-T4。 */
  boundLower: string;
  /** 真实偏移可行区间上界 T2-T1。 */
  boundUpper: string;
  /** 区间宽度（= 往返时延）。 */
  uncertainty: string;
  /** 是否为本批次代表样本。 */
  isRepresentative: boolean;
}

export interface BatchEvaluation {
  results: ExchangeResult[];
  invalid: InvalidEntry[];
  representative: ExchangeResult | null;
  /** 选择依据说明。 */
  representativeBasis: string | null;
  allInvalid: boolean;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function normalizeIntegerString(raw: unknown, field: string, maxDigits: number): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', `${field} 必须是十进制整数字符串`, { field });
  }
  const s = raw.trim();
  if (!INT_RE.test(s)) {
    throw new DomainError('VALIDATION_ERROR', `${field} 不是合法的十进制整数: ${raw}`, { field });
  }
  const digits = s.replace(/^-/, '');
  if (digits.replace(/^0+(?=\d)/, '').length > maxDigits) {
    throw new DomainError('LIMIT_EXCEEDED', `${field} 超过 ${maxDigits} 位整数限制`, { field, maxDigits });
  }
  return BigInt(s).toString();
}

function normalizeSeq(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new DomainError('VALIDATION_ERROR', 'seq 必须是正整数（字符串或数字）');
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || BigInt(s) <= 0n) {
    throw new DomainError('VALIDATION_ERROR', `seq 必须是正整数: ${raw}`);
  }
  const normalized = BigInt(s).toString();
  if (normalized.length > MAX_SEQ_DIGITS) {
    throw new DomainError('LIMIT_EXCEEDED', `seq 超过 ${MAX_SEQ_DIGITS} 位限制`);
  }
  return normalized;
}

/** 解析并规范化一条外部输入；格式错误直接抛出，语义问题交由 evaluateBatch 判定。 */
export function normalizeExchange(raw: unknown, index: number): RawExchange {
  if (typeof raw !== 'object' || raw === null) {
    throw new DomainError('VALIDATION_ERROR', `第 ${index} 条记录不是对象`, { index });
  }
  const rec = raw as Record<string, unknown>;
  return {
    seq: normalizeSeq(rec.seq),
    t1: normalizeIntegerString(rec.t1, 't1', MAX_TS_DIGITS),
    t2: normalizeIntegerString(rec.t2, 't2', MAX_TS_DIGITS),
    t3: normalizeIntegerString(rec.t3, 't3', MAX_TS_DIGITS),
    t4: normalizeIntegerString(rec.t4, 't4', MAX_TS_DIGITS),
  };
}

function frac(numerator: bigint, denominator: bigint): Fraction {
  if (denominator <= 0n) throw new Error('分数分母必须为正');
  return { numerator, denominator };
}

/** 精确比较两个分数：-1 / 0 / 1。 */
export function compareFraction(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const lhs = a.numerator * b.denominator;
  const rhs = b.numerator * a.denominator;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function fractionToString(f: Fraction): string {
  return `${f.numerator.toString()}/${f.denominator.toString()}`;
}

/** 浮点近似，仅供展示；使用 Number 除法，绝不回写核算。 */
export function fractionToApproxNumber(f: Fraction): number {
  return Number(f.numerator) / Number(f.denominator);
}

/**
 * 评估一整批交换记录。
 * - 相同编号、相同四个时间戳：幂等，仅保留一条。
 * - 相同编号、不同内容：列为非法（SEQ_CONFLICT），不参与核算。
 */
export function evaluateBatch(rawRecords: unknown[]): BatchEvaluation {
  if (!Array.isArray(rawRecords)) {
    throw new DomainError('VALIDATION_ERROR', 'records 必须是数组');
  }
  if (rawRecords.length > MAX_RECORDS_PER_BATCH) {
    throw new DomainError(
      'LIMIT_EXCEEDED',
      `单批次记录数超过上限 ${MAX_RECORDS_PER_BATCH}`,
      { maxRecords: MAX_RECORDS_PER_BATCH },
    );
  }

  const bySeq = new Map<string, RawExchange>();
  const results: ExchangeResult[] = [];
  const invalid: InvalidEntry[] = [];

  rawRecords.forEach((raw, i) => {
    let rec: RawExchange;
    try {
      rec = normalizeExchange(raw, i);
    } catch (err) {
      if (err instanceof DomainError) {
        const fallbackSeq =
          typeof raw === 'object' && raw !== null && 'seq' in raw ? String((raw as Record<string, unknown>).seq) : `#${i}`;
        invalid.push({ seq: fallbackSeq, reasons: [err.code] });
        return;
      }
      throw err;
    }

    const existing = bySeq.get(rec.seq);
    if (existing) {
      const same =
        existing.t1 === rec.t1 && existing.t2 === rec.t2 && existing.t3 === rec.t3 && existing.t4 === rec.t4;
      if (same) return; // 幂等接受
      invalid.push({
        seq: rec.seq,
        reasons: ['SEQ_CONFLICT'],
        t1: rec.t1,
        t2: rec.t2,
        t3: rec.t3,
        t4: rec.t4,
      });
      return;
    }
    bySeq.set(rec.seq, rec);

    results.push(evaluateOne(rec));
  });

  const valid = results.filter((r) => r.valid);
  valid.sort((a, b) => {
    const rttCmp = BigInt(a.rtt) < BigInt(b.rtt) ? -1 : BigInt(a.rtt) > BigInt(b.rtt) ? 1 : 0;
    if (rttCmp !== 0) return rttCmp;
    const sa = BigInt(a.seq);
    const sb = BigInt(b.seq);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const representative = valid[0] ?? null;
  let representativeBasis: string | null = null;
  if (representative) {
    const tied = valid.filter((r) => r.rtt === representative!.rtt).map((r) => r.seq);
    representativeBasis =
      tied.length === 1
        ? `记录 ${representative.seq} 的往返时延 ${representative.rtt} ns 为全部有效记录中最小，故选为代表样本。`
        : `记录 ${tied.join(', ')} 的往返时延同为最小值 ${representative.rtt} ns，按记录编号升序固定排序，选编号 ${representative.seq}。`;
  }

  for (const r of results) r.isRepresentative = false;
  if (representative) representative.isRepresentative = true;

  return {
    results,
    invalid,
    representative,
    representativeBasis,
    allInvalid: results.length > 0 && results.every((r) => !r.valid),
  };
}

function evaluateOne(rec: RawExchange): ExchangeResult {
  const t1 = BigInt(rec.t1);
  const t2 = BigInt(rec.t2);
  const t3 = BigInt(rec.t3);
  const t4 = BigInt(rec.t4);

  const clientElapsed = t4 - t1;
  const serverProcessing = t3 - t2;
  const rtt = clientElapsed - serverProcessing;

  const boundLower = t3 - t4;
  const boundUpper = t2 - t1;
  const offsetNum = boundLower + boundUpper; // ((T2-T1)+(T3-T4))，偏移 = 它 / 2
  const offset = frac(offsetNum, 2n);

  const reasons: string[] = [];
  // 注意：T2 与 T1、T3 与 T4 分属不同时钟，其大小关系由时钟偏移决定，不作合法性约束。
  if (clientElapsed < 0n) reasons.push('T4_BEFORE_T1');
  if (serverProcessing < 0n) reasons.push('T3_BEFORE_T2');
  if (rtt < 0n) reasons.push('NEGATIVE_RTT');

  const valid = reasons.length === 0;

  return {
    ...rec,
    valid,
    reasons,
    clientElapsed: clientElapsed.toString(),
    serverProcessing: serverProcessing.toString(),
    rtt: rtt.toString(),
    offsetNumerator: offset.numerator.toString(),
    offsetDenominator: offset.denominator.toString(),
    offsetApproxNanoseconds: fractionToApproxNumber(offset),
    boundLower: boundLower.toString(),
    boundUpper: boundUpper.toString(),
    uncertainty: (boundUpper - boundLower).toString(),
    isRepresentative: false,
  };
}
