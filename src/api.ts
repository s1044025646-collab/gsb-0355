// HTTP API：仅本地后端，无外部依赖。
import * as http from "node:http";
import { ApiError, Store } from "./db";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) reject(new ApiError(413, "BODY_TOO_LARGE", "请求体过大"));
      else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /pairs
      if (req.method === "POST" && url.pathname === "/pairs") {
        const body = await readBody(req);
        return send(res, 201, store.createPair(body.clientName, body.serverName));
      }
      // GET /pairs/:id
      if (req.method === "GET" && parts[0] === "pairs" && parts.length === 2) {
        return send(res, 200, store.getPair(parts[1]));
      }
      // POST /batches
      if (req.method === "POST" && url.pathname === "/batches") {
        const body = await readBody(req);
        if (!body.pairId) throw new ApiError(400, "INVALID_BODY", "缺少 pairId");
        return send(res, 201, store.createBatch(body.pairId));
      }
      // GET /batches/compare?a=&b=
      if (req.method === "GET" && url.pathname === "/batches/compare") {
        const a = url.searchParams.get("a");
        const b = url.searchParams.get("b");
        if (!a || !b) throw new ApiError(400, "INVALID_QUERY", "需要查询参数 a 与 b");
        return send(res, 200, store.compareBatches(a, b));
      }
      if (parts[0] === "batches" && parts.length >= 2) {
        const id = parts[1];
        // POST /batches/:id/records
        if (req.method === "POST" && parts[2] === "records") {
          const body = await readBody(req);
          return send(res, 200, store.importRecords(id, body.records));
        }
        // POST /batches/:id/finalize
        if (req.method === "POST" && parts[2] === "finalize") {
          return send(res, 200, store.finalizeBatch(id));
        }
        // GET /batches/:id/report
        if (req.method === "GET" && parts[2] === "report") {
          return send(res, 200, store.report(id));
        }
        // GET /batches/:id/representative
        if (req.method === "GET" && parts[2] === "representative") {
          return send(res, 200, store.representative(id));
        }
        // GET /batches/:id/export
        if (req.method === "GET" && parts[2] === "export") {
          return send(res, 200, store.exportBatch(id));
        }
        // GET /batches/:id
        if (req.method === "GET" && parts.length === 2) {
          return send(res, 200, store.report(id));
        }
      }
      throw new ApiError(404, "NOT_FOUND", `未知路由: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof ApiError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}
