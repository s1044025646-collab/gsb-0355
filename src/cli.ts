// CLI：创建时钟对、批量导入、核验、逐条报告、代表样本、比较、导出。
import * as fs from "node:fs";
import { formatOffsetApprox, formatOffsetExact } from "./core";
import { Store, defaultDbPath } from "./db";

const args = process.argv.slice(2);
const cmd = args[0];

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function required(name: string): string {
  const v = opt(name);
  if (v === undefined) {
    console.error(`缺少参数 --${name}`);
    process.exit(2);
  }
  return v;
}

const dbPath = opt("db") ?? process.env.CLOCK_DB ?? defaultDbPath();
const store = new Store(dbPath);

function showRecord(r: any) {
  if (!r.valid) {
    console.log(`  #${r.seq} 无效 [${r.errorCode}] ${r.errorMessage}`);
    return;
  }
  console.log(`  #${r.seq}`);
  console.log(`    客户端总耗时 (T4-T1):   ${r.clientTotal} ns`);
  console.log(`    服务端处理时间 (T3-T2): ${r.serverProcessing} ns`);
  console.log(`    网络往返时延:           ${r.rtt} ns`);
  console.log(`    偏移估计(精确分数):     ${formatOffsetExact(r.offset2)}`);
  console.log(`    偏移估计(近似值):       ${formatOffsetApprox(r.offset2)}`);
  console.log(`    真实偏移可行区间:       [${r.offsetLower}, ${r.offsetUpper}] ns`);
}

function showReport(report: any) {
  console.log(`批次 ${report.batchId} (时钟对 ${report.pairId}) 状态=${report.status} 规则=${report.ruleVersion} 单位=${report.unit}`);
  if (report.status === "finalized") {
    console.log(`有效 ${report.validCount} 条，无效 ${report.invalidCount} 条`);
    if (report.representative) {
      const rep = report.representative;
      console.log(`代表样本: #${rep.seq}，偏移 ${formatOffsetExact(rep.offset2)}，往返时延 ${rep.rtt} ns`);
      console.log(`选择依据: ${rep.reason}`);
    } else {
      console.log("代表样本: 无（全部记录无效，不发布偏移估计）");
    }
  }
  for (const r of report.records) showRecord(r);
}

try {
  switch (cmd) {
    case "create-pair": {
      const out = store.createPair(required("client"), required("server"));
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "new-batch": {
      console.log(JSON.stringify(store.createBatch(required("pair")), null, 2));
      break;
    }
    case "import": {
      // --batch <id> --file <json>，文件为 [{seq,t1,t2,t3,t4}, ...]
      const records = JSON.parse(fs.readFileSync(required("file"), "utf8"));
      console.log(JSON.stringify(store.importRecords(required("batch"), records), null, 2));
      break;
    }
    case "verify": // 完成批次并展示结论
    case "finalize": {
      showReport(store.finalizeBatch(required("batch")));
      break;
    }
    case "report": {
      showReport(store.report(required("batch")));
      break;
    }
    case "representative": {
      const rep = store.representative(required("batch"));
      console.log(`选择依据: ${rep.selectionReason}`);
      showRecord(rep.record);
      break;
    }
    case "compare": {
      const out = store.compareBatches(required("a"), required("b"));
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "export": {
      const out = store.exportBatch(required("batch"));
      const file = opt("out");
      const json = JSON.stringify(out, null, 2);
      if (file) {
        fs.writeFileSync(file, json);
        console.log(`已导出到 ${file}`);
      } else {
        console.log(json);
      }
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令> [选项] [--db 数据文件]
命令:
  create-pair --client 名 --server 名     创建时钟对
  new-batch --pair <id>                   创建批次
  import --batch <id> --file <json>       批量导入交换记录
  verify --batch <id>                     核验并完成批次（finalize）
  report --batch <id>                     查询逐条报告
  representative --batch <id>             查询代表样本
  compare --a <id> --b <id>               比较两个批次
  export --batch <id> [--out 文件]        导出批次
记录文件格式: [{"seq":0,"t1":"...","t2":"...","t3":"...","t4":"..."}, ...]（纳秒十进制整数字符串）`);
      if (cmd && cmd !== "help") process.exitCode = 2;
  }
} catch (err: any) {
  console.error(`错误 [${err.code ?? "INTERNAL"}] ${err.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
