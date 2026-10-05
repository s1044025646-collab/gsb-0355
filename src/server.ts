// 服务入口：默认端口 0（自动选择空闲端口），可用 --port 或 PORT 覆盖。
import { createServer } from "./api";
import { Store, defaultDbPath } from "./db";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(argValue("port") ?? process.env.PORT ?? 0);
const dbPath = argValue("db") ?? process.env.CLOCK_DB ?? defaultDbPath();

const store = new Store(dbPath);
const server = createServer(store);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`时钟偏移核算服务已启动: http://127.0.0.1:${actual}`);
  console.log(`数据文件: ${dbPath}`);
});

process.on("SIGINT", () => {
  server.close();
  store.close();
  process.exit(0);
});
