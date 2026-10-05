import { randomUUID } from 'node:crypto';
import { Store } from './db.js';
import {
  BatchEvaluation,
  DomainError,
  RULE_VERSION,
  TIME_UNIT,
  evaluateBatch,
  fractionToApproxNumber,
} from './domain.js';

export interface ImportOptions {
  batchId?: string;
  sourceNote?: string | null;
}

export class AuditService {
  constructor(readonly store: Store) {}

  createClockPair(pairId: string | undefined, clientLabel: string, serverLabel: string) {
    const id = pairId ?? `pair-${randomUUID()}`;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) {
      throw new DomainError('VALIDATION_ERROR', 'pairId 仅允许 1-80 位字母数字及 _ . : -');
    }
    if (!clientLabel.trim() || !serverLabel.trim()) {
      throw new DomainError('VALIDATION_ERROR', 'clientLabel 与 serverLabel 不能为空');
    }
    return this.store.createClockPair(id, clientLabel.trim(), serverLabel.trim());
  }

  /** 评估 -> 冻结写入 draft -> 置 complete，全程事务边界清晰；输入变更须用新 batchId 另建批次。 */
  importBatch(pairId: string, records: unknown[], opts: ImportOptions = {}) {
    const pair = this.store.getClockPair(pairId);
    if (!pair) throw new DomainError('PAIR_NOT_FOUND', `时钟对不存在: ${pairId}`);

    const evaluation = evaluateBatch(records);
    const batchId = opts.batchId ?? `batch-${randomUUID()}`;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(batchId)) {
      throw new DomainError('VALIDATION_ERROR', 'batchId 仅允许 1-80 位字母数字及 _ . : -');
    }
    if (this.store.getBatch(batchId)) {
      throw new DomainError('BATCH_EXISTS', `批次已存在（批次不可变，请用新批次保存修改后的输入）: ${batchId}`);
    }

    this.store.createBatch(batchId, pairId, opts.sourceNote ?? null);
    this.store.replaceBatchData(batchId, evaluation);
    this.store.finalizeBatch(batchId);

    return { batchId, ...this.getReport(batchId) };
  }

  getReport(batchId: string) {
    const meta = this.store.getBatch(batchId);
    if (!meta) throw new DomainError('BATCH_NOT_FOUND', `批次不存在: ${batchId}`);
    const exchanges = this.store.getExchanges(batchId);
    const invalid = this.store.getInvalid(batchId);
    const valid = exchanges.filter((r) => r.valid);
    const representative = valid.find((r) => r.isRepresentative) ?? null;
    let representativeBasis: string | null = null;
    if (representative) {
      const tied = valid.filter((r) => r.rtt === representative.rtt).map((r) => String(r.seq));
      representativeBasis =
        tied.length === 1
          ? `记录 ${representative.seq} 的往返时延 ${representative.rtt} ns 为全部有效记录中最小，故选为代表样本。`
          : `记录 ${tied.join(', ')} 的往返时延同为最小值 ${representative.rtt} ns，按记录编号升序固定排序，选编号 ${representative.seq}。`;
    }

    return {
      batch: { ...meta, frozenAt: meta.completedAt ?? meta.createdAt },
      ruleVersion: RULE_VERSION,
      unit: TIME_UNIT,
      interpretation:
        '偏移估计 offset = ((T2-T1)+(T3-T4))/2，依赖上下行路径对称假设；真实偏移位于 [T3-T4, T2-T1]。中点不是保证精确的同步值。',
      exchanges,
      invalid,
      summary: {
        total: exchanges.length + invalid.length,
        accepted: exchanges.length,
        invalid: invalid.length,
        validCount: valid.length,
        allInvalid: exchanges.length > 0 && valid.length === 0,
      },
      representative,
      representativeBasis,
      /** 全部无效时绝不发布可用偏移估计。 */
      usableOffsetEstimate: representative
        ? {
            seq: String(representative.seq),
            offsetFraction: `${String(representative.offsetNumerator)}/${String(representative.offsetDenominator)}`,
            offsetApproxNanoseconds: fractionToApproxNumber({
              numerator: BigInt(String(representative.offsetNumerator)),
              denominator: BigInt(String(representative.offsetDenominator)),
            }),
            rttNanoseconds: String(representative.rtt),
            feasibleInterval: {
              lowerNanoseconds: String(representative.boundLower),
              upperNanoseconds: String(representative.boundUpper),
            },
          }
        : null,
    };
  }

  /** 比较同一时钟对的多个批次（不同时钟对禁止混合平均）。 */
  compareBatches(batchIds: string[]) {
    if (!Array.isArray(batchIds) || batchIds.length < 2) {
      throw new DomainError('VALIDATION_ERROR', 'compare 至少需要两个 batchId');
    }
    const seen = new Set<string>();
    for (const id of batchIds) {
      if (seen.has(id)) throw new DomainError('VALIDATION_ERROR', `批次重复: ${id}`);
      seen.add(id);
    }
    const reports = batchIds.map((id) => this.getReport(id));
    const pairIds = new Set(reports.map((r) => r.batch.pairId));
    if (pairIds.size !== 1) {
      throw new DomainError('PAIR_MISMATCH', '只能比较属于同一时钟对的批次', { pairIds: [...pairIds] });
    }
    return {
      pairId: reports[0]!.batch.pairId,
      ruleVersion: RULE_VERSION,
      unit: TIME_UNIT,
      note: '仅做并列对比，不跨批次平均，不做长期漂移校准。',
      batches: reports.map((r) => ({
        batchId: r.batch.batchId,
        status: r.batch.status,
        sourceNote: r.batch.sourceNote,
        createdAt: r.batch.createdAt,
        accepted: r.summary.accepted,
        invalid: r.summary.invalid,
        representative: r.representative
          ? {
              seq: String(r.representative.seq),
              rtt: String(r.representative.rtt),
              offsetFraction: `${String(r.representative.offsetNumerator)}/${String(r.representative.offsetDenominator)}`,
              offsetApproxNanoseconds: r.representative.offsetApproxNanoseconds,
              feasibleInterval: {
                lowerNanoseconds: String(r.representative.boundLower),
                upperNanoseconds: String(r.representative.boundUpper),
              },
            }
          : null,
      })),
    };
  }
}

export type { BatchEvaluation };
