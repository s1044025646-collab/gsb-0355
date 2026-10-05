// SQLite 持久层：冻结原时间戳、单位、时钟对、规则版本、逐条判定与代表记录。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  ExchangeInput,
  MAX_RECORDS_PER_BATCH,
  RULE_VERSION,
  RecordVerdict,
  RepresentativeSelection,
  selectRepresentative,
  validateExchange,
} from "./core";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clock_pairs (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  server_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES clock_pairs(id),
  unit TEXT NOT NULL DEFAULT 'ns',
  rule_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | finalized
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  valid_count INTEGER,
  invalid_count INTEGER,
  rep_seq INTEGER,
  rep_offset2 TEXT,
  rep_rtt TEXT,
  rep_reason TEXT
);
CREATE TABLE IF NOT EXISTS records (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  t1 TEXT NOT NULL, t2 TEXT NOT NULL, t3 TEXT NOT NULL, t4 TEXT NOT NULL,
  valid INTEGER NOT NULL,
  error_code TEXT, error_message TEXT,
  client_total TEXT, server_processing TEXT, rtt TEXT,
  offset2 TEXT, offset_lower TEXT, offset_upper TEXT,
  PRIMARY KEY (batch_id, seq)
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createPair(clientName: string, serverName: string) {
    if (!clientName || !serverName) throw new ApiError(400, "INVALID_PAIR", "客户端与服务端名称不能为空");
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO clock_pairs (id, client_name, server_name, created_at) VALUES (?,?,?,?)")
      .run(id, clientName, serverName, new Date().toISOString());
    return { pairId: id, clientName, serverName };
  }

  getPair(pairId: string) {
    const row = this.db.prepare("SELECT * FROM clock_pairs WHERE id = ?").get(pairId) as any;
    if (!row) throw new ApiError(404, "PAIR_NOT_FOUND", `时钟对不存在: ${pairId}`);
    return { pairId: row.id, clientName: row.client_name, serverName: row.server_name, createdAt: row.created_at };
  }

  createBatch(pairId: string) {
    this.getPair(pairId);
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO batches (id, pair_id, unit, rule_version, status, created_at) VALUES (?,?,?,?, 'open', ?)")
      .run(id, pairId, "ns", RULE_VERSION, new Date().toISOString());
    return { batchId: id, pairId, ruleVersion: RULE_VERSION, unit: "ns", status: "open" };
  }

  getBatchRow(batchId: string): any {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId);
    if (!row) throw new ApiError(404, "BATCH_NOT_FOUND", `批次不存在: ${batchId}`);
    return row;
  }

  /** 批量导入：重复编号相同内容幂等接受，冲突内容拒绝；非法记录单独列出原因。 */
  importRecords(batchId: string, inputs: ExchangeInput[]) {
    const batch = this.getBatchRow(batchId);
    if (batch.status !== "open") throw new ApiError(409, "BATCH_FINALIZED", "批次已完成，不能继续导入；请创建新批次");
    if (!Array.isArray(inputs)) throw new ApiError(400, "INVALID_BODY", "records 必须为数组");
    const existing = this.db.prepare("SELECT COUNT(*) AS c FROM records WHERE batch_id = ?").get(batchId) as any;
    if (Number(existing.c) + inputs.length > MAX_RECORDS_PER_BATCH) {
      throw new ApiError(413, "LIMIT_EXCEEDED", `单批次记录数上限为 ${MAX_RECORDS_PER_BATCH}`);
    }
    const getStmt = this.db.prepare("SELECT * FROM records WHERE batch_id = ? AND seq = ?");
    const insStmt = this.db.prepare(
      `INSERT INTO records (batch_id, seq, t1, t2, t3, t4, valid, error_code, error_message,
         client_total, server_processing, rtt, offset2, offset_lower, offset_upper)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const accepted: number[] = [];
    const duplicates: number[] = [];
    const conflicts: Array<{ seq: number; code: string; message: string }> = [];
    const invalid: Array<{ seq: number; code: string; message: string }> = [];

    for (const input of inputs) {
      const verdict = validateExchange(input);
      const prior = getStmt.get(batchId, verdict.seq) as any;
      if (prior) {
        const same =
          prior.t1 === input.t1 && prior.t2 === input.t2 && prior.t3 === input.t3 && prior.t4 === input.t4;
        if (same) {
          duplicates.push(verdict.seq); // 幂等接受
        } else {
          conflicts.push({ seq: verdict.seq, code: "SEQ_CONFLICT", message: "相同编号已存在且内容不同，已拒绝" });
        }
        continue;
      }
      insStmt.run(
        batchId, verdict.seq, String(input.t1), String(input.t2), String(input.t3), String(input.t4),
        verdict.valid ? 1 : 0,
        verdict.errorCode ?? null, verdict.errorMessage ?? null,
        verdict.clientTotal ?? null, verdict.serverProcessing ?? null, verdict.rtt ?? null,
        verdict.offset2 ?? null, verdict.offsetLower ?? null, verdict.offsetUpper ?? null
      );
      if (verdict.valid) accepted.push(verdict.seq);
      else invalid.push({ seq: verdict.seq, code: verdict.errorCode!, message: verdict.errorMessage! });
    }
    return { accepted, duplicates, conflicts, invalid };
  }

  /** 完成批次：冻结逐条判定并选定代表样本。全部无效时不产生可用偏移估计。 */
  finalizeBatch(batchId: string) {
    const batch = this.getBatchRow(batchId);
    if (batch.status === "finalized") return this.report(batchId); // 幂等
    const rows = this.db
      .prepare("SELECT * FROM records WHERE batch_id = ? ORDER BY seq ASC")
      .all(batchId) as any[];
    const valid = rows.filter((r) => r.valid === 1);
    const rep: RepresentativeSelection | null = selectRepresentative(
      valid.map((r) => ({ seq: r.seq, rtt: r.rtt, offset2: r.offset2 }))
    );
    this.db
      .prepare(
        `UPDATE batches SET status='finalized', finalized_at=?, valid_count=?, invalid_count=?,
           rep_seq=?, rep_offset2=?, rep_rtt=?, rep_reason=? WHERE id=?`
      )
      .run(
        new Date().toISOString(), valid.length, rows.length - valid.length,
        rep?.seq ?? null, rep?.offset2 ?? null, rep?.rtt ?? null, rep?.reason ?? null, batchId
      );
    return this.report(batchId);
  }

  private rowToReport(r: any): RecordVerdict & { t1: string; t2: string; t3: string; t4: string } {
    return {
      seq: r.seq, t1: r.t1, t2: r.t2, t3: r.t3, t4: r.t4,
      valid: r.valid === 1,
      errorCode: r.error_code ?? undefined,
      errorMessage: r.error_message ?? undefined,
      clientTotal: r.client_total ?? undefined,
      serverProcessing: r.server_processing ?? undefined,
      rtt: r.rtt ?? undefined,
      offset2: r.offset2 ?? undefined,
      offsetLower: r.offset_lower ?? undefined,
      offsetUpper: r.offset_upper ?? undefined,
    };
  }

  report(batchId: string) {
    const batch = this.getBatchRow(batchId);
    const rows = this.db.prepare("SELECT * FROM records WHERE batch_id = ? ORDER BY seq ASC").all(batchId) as any[];
    return {
      batchId: batch.id,
      pairId: batch.pair_id,
      unit: batch.unit,
      ruleVersion: batch.rule_version,
      status: batch.status,
      createdAt: batch.created_at,
      finalizedAt: batch.finalized_at ?? null,
      validCount: batch.valid_count,
      invalidCount: batch.invalid_count,
      representative:
        batch.rep_seq === null || batch.rep_seq === undefined
          ? null
          : { seq: batch.rep_seq, offset2: batch.rep_offset2, rtt: batch.rep_rtt, reason: batch.rep_reason },
      records: rows.map((r) => this.rowToReport(r)),
    };
  }

  representative(batchId: string) {
    const batch = this.getBatchRow(batchId);
    if (batch.status !== "finalized") throw new ApiError(409, "BATCH_NOT_FINALIZED", "批次尚未完成，请先 finalize");
    if (batch.rep_seq === null || batch.rep_seq === undefined) {
      throw new ApiError(422, "NO_VALID_RECORDS", "批次内无有效记录，不存在可用偏移估计");
    }
    const row = this.db.prepare("SELECT * FROM records WHERE batch_id = ? AND seq = ?").get(batchId, batch.rep_seq) as any;
    return {
      batchId,
      selectionReason: batch.rep_reason,
      record: this.rowToReport(row),
    };
  }

  /** 比较两个已完成批次的代表样本（不同时钟对只并列展示，不混合平均）。 */
  compareBatches(aId: string, bId: string) {
    const a = this.getBatchRow(aId);
    const b = this.getBatchRow(bId);
    for (const x of [a, b]) {
      if (x.status !== "finalized") throw new ApiError(409, "BATCH_NOT_FINALIZED", `批次 ${x.id} 尚未完成`);
    }
    const side = (x: any) => ({
      batchId: x.id,
      pairId: x.pair_id,
      validCount: x.valid_count,
      invalidCount: x.invalid_count,
      representative:
        x.rep_seq === null ? null : { seq: x.rep_seq, offset2: x.rep_offset2, rtt: x.rep_rtt, reason: x.rep_reason },
    });
    let offset2Diff: string | null = null;
    let samePair = a.pair_id === b.pair_id;
    if (samePair && a.rep_offset2 !== null && b.rep_offset2 !== null) {
      offset2Diff = (BigInt(b.rep_offset2) - BigInt(a.rep_offset2)).toString();
    }
    return {
      sameClockPair: samePair,
      note: samePair ? "同一时钟对，代表偏移之差为精确半纳秒单位" : "不同时钟对，仅并列展示，不做混合平均",
      offset2Diff,
      a: side(a),
      b: side(b),
    };
  }

  exportBatch(batchId: string) {
    const batch = this.getBatchRow(batchId);
    const pair = this.getPair(batch.pair_id);
    const rows = this.db.prepare("SELECT * FROM records WHERE batch_id = ? ORDER BY seq ASC").all(batchId) as any[];
    return {
      format: "clock-offset-export",
      exportedAt: new Date().toISOString(),
      pair,
      batch: this.report(batchId),
      rawRecords: rows.map((r) => ({ seq: r.seq, t1: r.t1, t2: r.t2, t3: r.t3, t4: r.t4 })),
    };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "clock.db");
}
