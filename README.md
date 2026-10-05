# 四时间戳时钟偏移与往返时延核算后端

离线分析**虚构**的四时间戳时钟交换数据，精确核算客户端与服务端两个时钟之间的偏移估计与往返网络时延。
仅提供 HTTP API 与 CLI，无图形界面、无在线监控；不连接真实 NTP 服务器、不调用系统时钟、不读取地理位置、
不发送网络报文，也不做长期漂移校准。

- 语言/运行时：TypeScript + Node.js（要求 **Node >= 22.5**，使用内置 `node:sqlite`，无需编译原生模块）
- 存储：SQLite，数据库文件默认位于项目内 `data/audit.sqlite`
- 平台：Windows 本地直接运行，不依赖 Docker、WSL 或任何在线/付费服务

## 核算规则（规则版本 `four-ts-v1`）

每条交换记录四个时间戳，单位统一为**纳秒**，输入为十进制整数字符串：

| 戳 | 含义 | 时钟 |
| --- | --- | --- |
| T1 | 客户端发送时刻 | 客户端时钟 |
| T2 | 服务端接收时刻 | 服务端时钟 |
| T3 | 服务端发送时刻 | 服务端时钟 |
| T4 | 客户端接收时刻 | 客户端时钟 |

- 服务端相对客户端的偏移估计：`offset = ((T2-T1) + (T3-T4)) / 2`
- 往返网络时延：`rtt = (T4-T1) - (T3-T2)`（服务端处理时长 `T3-T2` 被扣除，不计入网络往返）
- 真实偏移可行区间（单次交换内两钟等速、单向传播非负）：`[T3-T4, T2-T1]`
  - 中点估计依赖**上下行路径对称**假设；路径不对称时中点可能偏离真实偏移，真实偏移只保证落在区间内。

### 精确性

- 内部全程使用 `bigint`，时间戳不先转为 `Number`；支持远超 `Number.MAX_SAFE_INTEGER`（最多 24 位十进制）。
- 偏移可能是半纳秒，以精确分数 `numerator/denominator` 保存（本版本分母恒为 2，分子即“半纳秒整数单位”）。
- `offsetApproxNanoseconds` 为浮点近似值，**仅用于展示**，不参与任何核算、选择或持久化复算。

### 合法性判定与错误码

- `T4_BEFORE_T1`：`T4 < T1`（客户端时间倒流）
- `T3_BEFORE_T2`：`T3 < T2`（服务端处理时长为负）
- `NEGATIVE_RTT`：往返时延为负
- 跨时钟的 `T2` 与 `T1` 大小关系由时钟偏移决定，**不因 T2 早于 T1 判非法**。
- 输入层错误码：`VALIDATION_ERROR`（格式/非整数/空标签等）、`LIMIT_EXCEEDED`（超位数/超 10000 条）。
- 记录编号：正整数；**同编号同四戳幂等接受**，**同编号不同内容拒绝**（`SEQ_CONFLICT`）。
- 非法记录单独列出且不参与统计；一批记录全部无效时**不发布**可用偏移估计。

### 代表样本

在有效记录中选**往返时延最小**者作为代表；平局按记录编号升序固定排序，报告同时返回人类可读的选择依据。
不同时钟对的数据永不混合平均；批次之间只并列比较。

### 冻结与不可变

SQLite 保存原始四戳字符串、单位、时钟对、规则版本、逐条判定、代表标记。
批次状态为 `draft → complete`：导入在一个事务内写入并立即置为 `complete`，此后不可修改；
修改输入必须创建**新批次**，旧报告永远按原数据复算。重启后查询与代表选择结果一致。

## 快速开始

```powershell
npm install
npm run demo      # 内置合成示例：对称/非对称路径、零延迟、负偏移、半纳秒、冲突
npm test          # 13 个测试：公式、平局、失败隔离、平移不变性、重启持久化、HTTP API
npm run build     # TypeScript 类型检查 + 编译到 dist/
npm start         # 启动 HTTP API，默认由系统分配空闲端口
```

## CLI

全局选项 `--db <路径>` 指定数据库（默认 `data/audit.sqlite`），`--port` 仅用于 `serve`（0 或省略 = 空闲端口）。

```powershell
# 服务
npx tsx src/cli.ts serve --port 0

# 时钟对
npx tsx src/cli.ts pair:create "办公PC" "机房S" --id pair-1
npx tsx src/cli.ts pair:list

# 批量导入（文件为记录数组，或 { "records": [...] }；用 - 表示标准输入）
npx tsx src/cli.ts import pair-1 examples/records.sample.json --batch-id b001 --note "首轮采样"

# 逐条报告 / 批次比较 / 导出
npx tsx src/cli.ts report b001
npx tsx src/cli.ts compare b001 b002 b003
npx tsx src/cli.ts export b001 --out data/b001.json
```

CLI 逐条展示：客户端总耗时 `T4-T1`、服务端处理时长 `T3-T2`、网络往返时延、
偏移精确分数与近似值（明确分开）、可行区间及代表样本选择依据。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/pairs` | 创建时钟对，body：`{pairId?, clientLabel, serverLabel}` |
| GET | `/api/pairs` | 列出时钟对 |
| GET | `/api/pairs/:pairId` | 查询单个时钟对 |
| POST | `/api/pairs/:pairId/batches` | 批量导入并核算，body：`{batchId?, sourceNote?, records:[...]}` |
| GET | `/api/batches?pairId=` | 列出批次（可按时钟对过滤） |
| GET | `/api/batches/:batchId` | 完整逐条报告 |
| POST | `/api/compare` | body：`{batchIds:[...]}`，仅允许同一时钟对 |

错误响应统一为 `{ "error": { "code", "message" } }`，HTTP 状态：400 校验/超限、404 不存在、
409 冲突（`PAIR_EXISTS`/`BATCH_EXISTS`/`PAIR_MISMATCH`）、500 内部错误。

```powershell
$body = @{ records = @(
  @{ seq='1'; t1='1000000000'; t2='1000260000'; t3='1000265000'; t4='1000025000' }
) } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:<端口>/api/pairs/pair-1/batches `
  -Method Post -ContentType 'application/json' -Body $body
```

## 限制与假设

- 仅分析虚构离线数据；不做网络对时、不校准系统时钟、不做漂移模型与复杂滤波。
- 偏移以固定时钟对、单批次为上下文；跨时钟对、跨批次不做聚合平均。
- 上限：单批次 10000 条，时间戳 ≤ 24 位十进制整数，编号 ≤ 18 位。
- `node:sqlite` 在当前 Node 版本标记为实验性（运行时会有一行 ExperimentalWarning，不影响功能）。
