// 演示：合成已知偏移/处理时长/上下行延迟的数据，走一遍 CLI 全流程。
// 运行：npm run build 后执行 npm run demo
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const db = path.join(__dirname, "..", "data", "demo.db");
fs.rmSync(db, { force: true });
const cli = path.join(__dirname, "..", "dist", "src", "cli.js");
const run = (args) => execFileSync(process.execPath, [cli, ...args, "--db", db], { encoding: "utf8" });

// 合成参数：真实偏移 +1000ns（服务端快），处理 50ns
const OFF = 1000n, PROC = 50n;
const records = [];
let t1 = 1_000_000_000_000n;
// 对称路径：上下行各 200ns → 中点应等于真实偏移
for (let i = 0; i < 3; i++) {
  const up = 200n, down = 200n;
  const t2 = t1 + up + OFF, t3 = t2 + PROC, t4 = t3 + down - OFF;
  records.push({ seq: i, t1: `${t1}`, t2: `${t2}`, t3: `${t3}`, t4: `${t4}` });
  t1 += 1_000_000n;
}
// 不对称路径：上 400ns 下 100ns → 中点有偏差，但真实偏移仍在区间内
{
  const up = 400n, down = 100n;
  const t2 = t1 + up + OFF, t3 = t2 + PROC, t4 = t3 + down - OFF;
  records.push({ seq: 3, t1: `${t1}`, t2: `${t2}`, t3: `${t3}`, t4: `${t4}` });
}
// 一条非法记录：负网络时延
records.push({ seq: 9, t1: "0", t2: "5", t3: "100", t4: "50" });

const file = path.join(__dirname, "..", "data", "demo-records.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(records, null, 2));

console.log("== 创建时钟对 ==");
const pair = JSON.parse(run(["create-pair", "--client", "demo-client", "--server", "demo-server"]));
console.log(`pairId = ${pair.pairId}`);
console.log("== 创建批次并导入 ==");
const batch = JSON.parse(run(["new-batch", "--pair", pair.pairId]));
console.log(run(["import", "--batch", batch.batchId, "--file", file]));
console.log("== 核验（finalize）==");
console.log(run(["verify", "--batch", batch.batchId]));
console.log(`真实偏移为 +${OFF}ns：对称样本(seq 0-2)中点应恰为 1000ns；不对称样本(seq 3)真实偏移仍落在区间内。`);
