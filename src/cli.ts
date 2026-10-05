#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase, Store } from './db.js';
import { AuditService } from './service.js';
import { createApp, listen } from './server.js';
import { DomainError } from './domain.js';
import { demoRecordsSymmetric, demoRecordsAsymmetric, demoRecordsNegative } from './demo.js';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function defaultDbPath(): string {
  return resolve(process.cwd(), 'data', 'audit.sqlite');
}

function makeService(flags: Record<string, string | boolean>): AuditService {
  const dbPath = typeof flags.db === 'string' ? resolve(flags.db) : defaultDbPath();
  mkdirSync(resolve(dbPath, '..'), { recursive: true });
  return new AuditService(new Store(openDatabase(dbPath)));
}

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printReport(report: ReturnType<AuditService['getReport']>): void {
  line(`批次报告 ${report.batch.batchId}`);
  console.log(`时钟对: ${report.batch.pairId} | 状态: ${report.batch.status} | 规则版本: ${report.ruleVersion} | 单位: ${report.unit}`);
  console.log(`创建: ${report.batch.createdAt} | 冻结: ${report.batch.frozenAt}`);
  if (report.batch.sourceNote) console.log(`备注: ${report.batch.sourceNote}`);
  console.log(`记录: 共 ${report.summary.total}，接受 ${report.summary.accepted}，非法 ${report.summary.invalid}，有效 ${report.summary.validCount}`);

  for (const ex of report.exchanges) {
    const tag = ex.isRepresentative ? '  [代表样本]' : '';
    console.log(
      `\n#${ex.seq}${tag} ${ex.valid ? '有效' : '无效(' + (ex.reasons as string[]).join(',') + ')'}\n` +
        `  T1=${ex.t1} T2=${ex.t2} T3=${ex.t3} T4=${ex.t4} (ns)\n` +
        `  客户端总耗时 T4-T1 = ${ex.clientElapsed} ns\n` +
        `  服务端处理 T3-T2 = ${ex.serverProcessing} ns（不计入网络往返）\n` +
        `  网络往返时延 RTT = (T4-T1)-(T3-T2) = ${ex.rtt} ns\n` +
        `  偏移分数 offset = ${ex.offsetNumerator}/${ex.offsetDenominator} ns（精确）\n` +
        `  偏移近似值 ≈ ${ex.offsetApproxNanoseconds} ns（仅展示）\n` +
        `  真实偏移可行区间 [T3-T4, T2-T1] = [${ex.boundLower}, ${ex.boundUpper}] ns（宽度 ${ex.uncertainty}）`,
    );
  }
  for (const inv of report.invalid) {
    console.log(`\n#${inv.seq} 已拒绝: ${(inv.reasons as string[]).join(', ')}`);
  }

  line('代表样本结论');
  if (report.representativeBasis) {
    console.log(report.representativeBasis);
  } else {
    console.log('不存在任何有效记录，不发布偏移估计。');
  }
  if (report.usableOffsetEstimate) {
    const e = report.usableOffsetEstimate;
    console.log(
      `可用估计: offset(精确分数)=${e.offsetFraction} ns，≈${e.offsetApproxNanoseconds} ns；` +
        `RTT=${e.rttNanoseconds} ns；可行区间=[${e.feasibleInterval.lowerNanoseconds}, ${e.feasibleInterval.upperNanoseconds}]`,
    );
    console.log('注意: 中点估计依赖上下行路径对称；不对称时真实偏移只保证落在区间内。');
  }
}

function loadRecords(fileOrJson: string): unknown[] {
  let text: string;
  if (fileOrJson === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    text = readFileSync(resolve(fileOrJson), 'utf8');
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown[] }).records)) {
    return (parsed as { records: unknown[] }).records;
  }
  throw new DomainError('VALIDATION_ERROR', '导入文件须是记录数组，或含 records 数组的对象');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'serve': {
      const service = makeService(args.flags);
      const requested = args.flags.port === undefined ? 0 : Number(args.flags.port);
      if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
        throw new DomainError('VALIDATION_ERROR', '--port 必须是 0-65535 的整数（0 或省略=系统分配空闲端口）');
      }
      const port = await listen(createApp(service), requested);
      console.log(`四时间戳核算服务已启动: http://127.0.0.1:${port}`);
      console.log('按 Ctrl+C 退出。');
      break;
    }

    case 'pair:create': {
      const [clientLabel, serverLabel] = args.positional;
      if (!clientLabel || !serverLabel) throw new DomainError('VALIDATION_ERROR', '用法: pair:create <客户端标签> <服务端标签> [--id ID]');
      const pair = makeService(args.flags).createClockPair(
        typeof args.flags.id === 'string' ? args.flags.id : undefined,
        clientLabel,
        serverLabel,
      );
      console.log(`已创建时钟对: ${pair.pairId}（${pair.clientLabel} <-> ${pair.serverLabel}）`);
      break;
    }

    case 'pair:list': {
      for (const p of makeService(args.flags).store.listClockPairs()) {
        console.log(`${p.pairId}\t${p.clientLabel}\t${p.serverLabel}\t${p.createdAt}`);
      }
      break;
    }

    case 'import': {
      const [pairId, file] = args.positional;
      if (!pairId || !file) throw new DomainError('VALIDATION_ERROR', '用法: import <pairId> <records.json|-> [--batch-id ID] [--note 备注]');
      const report = makeService(args.flags).importBatch(pairId, loadRecords(file), {
        batchId: typeof args.flags['batch-id'] === 'string' ? args.flags['batch-id'] : undefined,
        sourceNote: typeof args.flags.note === 'string' ? args.flags.note : null,
      });
      printReport(report);
      break;
    }

    case 'report': {
      const [batchId] = args.positional;
      if (!batchId) throw new DomainError('VALIDATION_ERROR', '用法: report <batchId>');
      printReport(makeService(args.flags).getReport(batchId));
      break;
    }

    case 'compare': {
      if (args.positional.length < 2) throw new DomainError('VALIDATION_ERROR', '用法: compare <batchId1> <batchId2> ...');
      const result = makeService(args.flags).compareBatches(args.positional);
      line(`批次比较（时钟对 ${result.pairId}）`);
      console.log(result.note);
      for (const b of result.batches) {
        if (b.representative) {
          console.log(
            `${b.batchId}\t代表#${b.representative.seq}\tRTT=${b.representative.rtt}\toffset=${b.representative.offsetFraction} ns（≈${b.representative.offsetApproxNanoseconds}）\t区间=[${b.representative.feasibleInterval.lowerNanoseconds}, ${b.representative.feasibleInterval.upperNanoseconds}]\t接受${b.accepted}/非法${b.invalid}`,
          );
        } else {
          console.log(`${b.batchId}\t无有效记录（接受${b.accepted}/非法${b.invalid}），不发布估计`);
        }
      }
      break;
    }

    case 'export': {
      const [batchId] = args.positional;
      if (!batchId) throw new DomainError('VALIDATION_ERROR', '用法: export <batchId> [--out file.json]');
      const report = makeService(args.flags).getReport(batchId);
      const json = JSON.stringify(report, null, 2);
      if (typeof args.flags.out === 'string') {
        const out = resolve(args.flags.out);
        writeFileSync(out, json, 'utf8');
        console.log(`已导出: ${out}`);
      } else {
        process.stdout.write(json + '\n');
      }
      break;
    }

    case 'demo': {
      runDemo(args.flags);
      break;
    }

    default:
      console.log(
        [
          '用法: tsx src/cli.ts <命令> [选项]',
          '命令:',
          '  serve [--port 0] [--db data/audit.sqlite]        启动 HTTP API（默认自动选择空闲端口）',
          '  pair:create <客户端> <服务端> [--id ID] [--db ..] 创建时钟对',
          '  pair:list [--db ..]                               列出时钟对',
          '  import <pairId> <records.json|-> [--batch-id ID] [--note ..]  批量导入并核算',
          '  report <batchId> [--db ..]                        查询逐条报告',
          '  compare <batchId1> <batchId2> ... [--db ..]       比较同一时钟对的批次',
          '  export <batchId> [--out file.json] [--db ..]      导出完整报告 JSON',
          '  demo [--db data/demo.sqlite]                      运行内置合成示例',
        ].join('\n'),
      );
      if (!command) process.exitCode = 1;
  }
}

function runDemo(flags: Record<string, string | boolean>): void {
  const dbFlag = flags.db === undefined ? { db: resolve(process.cwd(), 'data', 'demo.sqlite') } : flags;
  const service = makeService(dbFlag);
  const pair = service.createClockPair('pair-demo', '虚构客户端C', '虚构服务端S');
  console.log(`时钟对: ${pair.pairId}`);

  const sym = service.importBatch('pair-demo', demoRecordsSymmetric(), {
    batchId: 'demo-symmetric',
    sourceNote: '对称路径合成数据：上下行各 10000 ns，真实偏移 +250000 ns',
  });
  printReport(sym);

  const asym = service.importBatch('pair-demo', demoRecordsAsymmetric(), {
    batchId: 'demo-asymmetric',
    sourceNote: '非对称路径合成数据：下行 30000 / 上行 5000 ns，真实偏移仍在区间内',
  });
  printReport(asym);

  const neg = service.importBatch('pair-demo', demoRecordsNegative(), {
    batchId: 'demo-negative',
    sourceNote: '异常与边界：零延迟、负偏移、半纳秒、负时延、编号冲突',
  });
  printReport(neg);

  console.log('\n=== compare demo-symmetric demo-asymmetric ===');
  console.log(JSON.stringify(service.compareBatches(['demo-symmetric', 'demo-asymmetric']).batches, null, 2));
}

main().catch((err: unknown) => {
  if (err instanceof DomainError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error('错误:', (err as Error).stack ?? err);
  }
  process.exit(1);
});
