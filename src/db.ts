import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BatchEvaluation, DomainError, RULE_VERSION, TIME_UNIT } from './domain.js';

export interface ClockPair {
  pairId: string;
  clientLabel: string;
  serverLabel: string;
  createdAt: string;
}

export interface BatchMeta {
  batchId: string;
  pairId: string;
  status: 'draft' | 'complete';
  ruleVersion: string;
  unit: string;
  recordCount: number;
  invalidCount: number;
  sourceNote: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Windows 上使用默认 rollback journal 模式，避免 WAL 句柄延迟释放导致临时目录删除失败。
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clock_pairs (
      pair_id       TEXT PRIMARY KEY,
      client_label  TEXT NOT NULL,
      server_label  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS batches (
      batch_id      TEXT PRIMARY KEY,
      pair_id       TEXT NOT NULL REFERENCES clock_pairs(pair_id),
      status        TEXT NOT NULL CHECK (status IN ('draft','complete')),
      rule_version  TEXT NOT NULL,
      unit          TEXT NOT NULL,
      record_count  INTEGER NOT NULL,
      invalid_count INTEGER NOT NULL,
      source_note   TEXT,
      created_at    TEXT NOT NULL,
      completed_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS exchanges (
      batch_id            TEXT NOT NULL REFERENCES batches(batch_id),
      seq                 TEXT NOT NULL,
      t1                  TEXT NOT NULL,
      t2                  TEXT NOT NULL,
      t3                  TEXT NOT NULL,
      t4                  TEXT NOT NULL,
      valid               INTEGER NOT NULL,
      reasons             TEXT NOT NULL,
      client_elapsed      TEXT NOT NULL,
      server_processing   TEXT NOT NULL,
      rtt                 TEXT NOT NULL,
      offset_numerator    TEXT NOT NULL,
      offset_denominator  TEXT NOT NULL,
      offset_approx       REAL NOT NULL,
      bound_lower         TEXT NOT NULL,
      bound_upper         TEXT NOT NULL,
      uncertainty         TEXT NOT NULL,
      is_representative   INTEGER NOT NULL,
      PRIMARY KEY (batch_id, seq)
    );
    CREATE TABLE IF NOT EXISTS invalid_records (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id  TEXT NOT NULL REFERENCES batches(batch_id),
      seq       TEXT NOT NULL,
      reasons   TEXT NOT NULL,
      t1        TEXT,
      t2        TEXT,
      t3        TEXT,
      t4        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_batches_pair ON batches(pair_id);
    CREATE INDEX IF NOT EXISTS idx_exchanges_batch ON exchanges(batch_id);
    CREATE INDEX IF NOT EXISTS idx_invalid_batch ON invalid_records(batch_id);
  `);
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  createClockPair(pairId: string, clientLabel: string, serverLabel: string): ClockPair {
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare('INSERT INTO clock_pairs (pair_id, client_label, server_label, created_at) VALUES (?, ?, ?, ?)')
        .run(pairId, clientLabel, serverLabel, createdAt);
    } catch (err) {
      const message = (err as Error).message ?? '';
      if ((err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        message.includes('UNIQUE constraint failed') || message.includes('PRIMARY KEY')) {
        throw new DomainError('PAIR_EXISTS', `时钟对已存在: ${pairId}`);
      }
      throw err;
    }
    return { pairId, clientLabel, serverLabel, createdAt };
  }

  getClockPair(pairId: string): ClockPair | null {
    const row = this.db
      .prepare('SELECT pair_id AS pairId, client_label AS clientLabel, server_label AS serverLabel, created_at AS createdAt FROM clock_pairs WHERE pair_id = ?')
      .get(pairId) as ClockPair | undefined;
    return row ?? null;
  }

  listClockPairs(): ClockPair[] {
    return this.db
      .prepare('SELECT pair_id AS pairId, client_label AS clientLabel, server_label AS serverLabel, created_at AS createdAt FROM clock_pairs ORDER BY created_at, pair_id')
      .all() as unknown as ClockPair[];
  }

  createBatch(batchId: string, pairId: string, sourceNote: string | null): void {
    this.db
      .prepare(
        `INSERT INTO batches (batch_id, pair_id, status, rule_version, unit, record_count, invalid_count, source_note, created_at)
         VALUES (?, ?, 'draft', ?, ?, 0, 0, ?, ?)`,
      )
      .run(batchId, pairId, RULE_VERSION, TIME_UNIT, sourceNote, new Date().toISOString());
  }

  /** 仅 draft 批次可替换数据；整批核算结果在一个事务内冻结写入。 */
  replaceBatchData(batchId: string, evaluation: BatchEvaluation): void {
    const insExchange = this.db.prepare(
      `INSERT INTO exchanges (batch_id, seq, t1, t2, t3, t4, valid, reasons,
         client_elapsed, server_processing, rtt, offset_numerator, offset_denominator,
         offset_approx, bound_lower, bound_upper, uncertainty, is_representative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insInvalid = this.db.prepare(
      `INSERT INTO invalid_records (batch_id, seq, reasons, t1, t2, t3, t4) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM exchanges WHERE batch_id = ?').run(batchId);
      this.db.prepare('DELETE FROM invalid_records WHERE batch_id = ?').run(batchId);
      for (const r of evaluation.results) {
        insExchange.run(
          batchId,
          r.seq,
          r.t1,
          r.t2,
          r.t3,
          r.t4,
          r.valid ? 1 : 0,
          JSON.stringify(r.reasons),
          r.clientElapsed,
          r.serverProcessing,
          r.rtt,
          r.offsetNumerator,
          r.offsetDenominator,
          r.offsetApproxNanoseconds,
          r.boundLower,
          r.boundUpper,
          r.uncertainty,
          r.isRepresentative ? 1 : 0,
        );
      }
      for (const inv of evaluation.invalid) {
        insInvalid.run(
          batchId,
          inv.seq,
          JSON.stringify(inv.reasons),
          inv.t1 ?? null,
          inv.t2 ?? null,
          inv.t3 ?? null,
          inv.t4 ?? null,
        );
      }
      this.db
        .prepare('UPDATE batches SET record_count = ?, invalid_count = ? WHERE batch_id = ?')
        .run(evaluation.results.length, evaluation.invalid.length, batchId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** draft -> complete，完成后不可变。返回 false 表示状态不允许。 */
  finalizeBatch(batchId: string): boolean {
    const info = this.db
      .prepare("UPDATE batches SET status = 'complete', completed_at = ? WHERE batch_id = ? AND status = 'draft'")
      .run(new Date().toISOString(), batchId);
    return info.changes === 1;
  }

  getBatch(batchId: string): BatchMeta | null {
    const row = this.db
      .prepare(
        `SELECT batch_id AS batchId, pair_id AS pairId, status, rule_version AS ruleVersion, unit,
                record_count AS recordCount, invalid_count AS invalidCount,
                source_note AS sourceNote, created_at AS createdAt, completed_at AS completedAt
         FROM batches WHERE batch_id = ?`,
      )
      .get(batchId) as BatchMeta | undefined;
    return row ?? null;
  }

  listBatches(pairId?: string): BatchMeta[] {
    const sql =
      'SELECT batch_id AS batchId, pair_id AS pairId, status, rule_version AS ruleVersion, unit, record_count AS recordCount, invalid_count AS invalidCount, source_note AS sourceNote, created_at AS createdAt, completed_at AS completedAt FROM batches';
    const rows = pairId
      ? (this.db.prepare(sql + ' WHERE pair_id = ? ORDER BY created_at, batch_id').all(pairId) as unknown as BatchMeta[])
      : (this.db.prepare(sql + ' ORDER BY created_at, batch_id').all() as unknown as BatchMeta[]);
    return rows;
  }

  getExchanges(batchId: string): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT seq, t1, t2, t3, t4, valid, reasons, client_elapsed AS clientElapsed,
                server_processing AS serverProcessing, rtt, offset_numerator AS offsetNumerator,
                offset_denominator AS offsetDenominator, offset_approx AS offsetApproxNanoseconds,
                bound_lower AS boundLower, bound_upper AS boundUpper, uncertainty,
                is_representative AS isRepresentative
         FROM exchanges WHERE batch_id = ? ORDER BY CAST(seq AS INTEGER)`,
      )
      .all(batchId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        r.valid = r.valid === 1;
        r.isRepresentative = r.isRepresentative === 1;
        r.reasons = JSON.parse(String(r.reasons)) as string[];
        return r;
      }) as Record<string, unknown>[];
  }

  getInvalid(batchId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT seq, reasons, t1, t2, t3, t4 FROM invalid_records WHERE batch_id = ? ORDER BY id')
      .all(batchId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        r.reasons = JSON.parse(String(r.reasons)) as string[];
        return r;
      }) as Record<string, unknown>[];
  }
}
