// API 冒烟测试：npm run build 后执行 node scripts/api-smoke.js
process.env.CLOCK_DB = require("path").join(require("os").tmpdir(), "api-smoke.db");
require("fs").rmSync(process.env.CLOCK_DB, { force: true });
const { Store } = require("../dist/src/db");
const { createServer } = require("../dist/src/api");

const srv = createServer(new Store(process.env.CLOCK_DB));
srv.listen(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  const call = async (m, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: m,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  const pair = (await call("POST", "/pairs", { clientName: "c", serverName: "s" })).json;
  const b1 = (await call("POST", "/batches", { pairId: pair.pairId })).json;
  await call("POST", `/batches/${b1.batchId}/records`, {
    records: [
      { seq: 0, t1: "0", t2: "100", t3: "110", t4: "150" },
      { seq: 1, t1: "0", t2: "5", t3: "100", t4: "50" },
    ],
  });
  await call("POST", `/batches/${b1.batchId}/finalize`);
  const b2 = (await call("POST", "/batches", { pairId: pair.pairId })).json;
  await call("POST", `/batches/${b2.batchId}/records`, { records: [{ seq: 0, t1: "0", t2: "120", t3: "130", t4: "150" }] });
  await call("POST", `/batches/${b2.batchId}/finalize`);
  const rep = await call("GET", `/batches/${b1.batchId}/representative`);
  console.log("representative:", rep.status, "offset2=", rep.json.record.offset2, "|", rep.json.selectionReason);
  const cmp = await call("GET", `/batches/compare?a=${b1.batchId}&b=${b2.batchId}`);
  console.log("compare:", cmp.status, "offset2Diff=", cmp.json.offset2Diff);
  const bad = await call("GET", "/batches/nope/report");
  console.log("not-found:", bad.status, bad.json.error.code);
  const exp = await call("GET", `/batches/${b1.batchId}/export`);
  console.log("export:", exp.status, exp.json.format, "records=", exp.json.rawRecords.length);
  srv.close();
  process.exit(0);
});
