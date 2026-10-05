# 四时间戳时钟偏移与往返时延核算后端

离线、纯本地的时钟比较服务。输入为一批"四时间戳"交换记录，输出每条记录的
偏移估计、网络往返时延、真实偏移可行区间，以及批次的代表样本。只做 API 与 CLI，
不连接真实 NTP 服务器、不读系统时钟、不获取地理位置、不做网络报文与长期漂移校准。

技术栈：TypeScript + Node.js（>= 22.5，使用内置 `node:sqlite`）+ SQLite。零运行时依赖，
Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 计算规则（规则版本 v1）

每条记录：客户端发送 `T1`、服务端接收 `T2`、服务端发送 `T3`、客户端接收 `T4`，
单位统一为纳秒，输入为十进制整数字符串（允许负值，最多 30 位）。

- 偏移估计（服务端相对客户端）：`offset = ((T2-T1) + (T3-T4)) / 2`
- 网络往返时延：`rtt = (T4-T1) - (T3-T2)`（**不含**服务端处理时间 `T3-T2`）
- 真实偏移可行区间（单次交换内两钟等速、单向传播时间非负）：`[T3-T4, T2-T1]`

内部全部使用 BigInt。偏移以 **2 倍偏移整数**（半纳秒单位）精确保存，
例如 `offset2 = 3` 表示 `3/2 ns`；显示时区分精确分数（`3/2 ns`）与近似值（`1.5 ns`），
近似值仅供阅读，不参与任何计算与存储。

**对称性说明**：中点估计 `offset` 依赖上下行路径对称假设。上下行不对称时中点可能
偏离真实偏移，但真实偏移仍落在可行区间内。区间中点不是精确同步值。

## 校验规则与错误码

| 校验 | 错误码 |
| --- | --- |
| 时间戳须为十进制整数字符串且 ≤ 30 位 | `INVALID_TIMESTAMP` |
| 记录编号须为非负安全整数 | `INVALID_SEQ` |
| `T4 >= T1` | `T4_BEFORE_T1` |
| `T3 >= T2` | `T3_BEFORE_T2` |
| 往返时延非负 | `NEGATIVE_RTT` |

注意：`T2` 与 `T1` 属于不同时钟，跨时钟比较不用于判非法（时钟偏移下 `T2 < T1` 合法）。
其他错误码：`SEQ_CONFLICT`（同编号内容冲突）、`BATCH_FINALIZED`、`BATCH_NOT_FINALIZED`、
`NO_VALID_RECORDS`、`PAIR_NOT_FOUND`、`BATCH_NOT_FOUND`、`LIMIT_EXCEEDED`（单批次上限 10000 条）、
`INVALID_JSON`、`INVALID_BODY`、`BODY_TOO_LARGE`、`NOT_FOUND`。

## 语义约定

- **幂等导入**：同编号同内容重复导入幂等接受；同编号不同内容拒绝（`SEQ_CONFLICT`）。
- **非法记录**：单独列出原因并入库冻结，不参与代表选择；全部无效时批次不发布任何可用偏移估计。
- **代表样本**：有效记录中往返时延最小者；平局按记录编号升序取先，返回选择依据。
- **冻结与不可变**：批次 `finalize` 后只读；修改输入须创建新批次，旧报告仍按原数据核算。
  SQLite 中冻结原时间戳、单位、时钟对、规则版本、逐条判定与代表记录，重启后查询结果一致。
- **比较**：仅同一时钟对的两个批次给出代表偏移之差；不同时钟对只并列展示，不混合平均。

## 快速开始

```bat
npm install
npm run build     :: 编译 TypeScript 到 dist/
npm test          :: 构建并运行全部测试
npm start         :: 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      :: 合成数据演示（对称/不对称路径 + 非法记录）
```

可配置端口：`npm start -- --port 8080`，或环境变量 `PORT`。
数据目录默认为项目内 `data/`（可用 `--db 路径` 或环境变量 `CLOCK_DB` 覆盖）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/pairs` | 创建时钟对 `{clientName, serverName}` |
| GET | `/pairs/:id` | 查询时钟对 |
| POST | `/batches` | 创建批次 `{pairId}` |
| POST | `/batches/:id/records` | 批量导入 `{records:[{seq,t1,t2,t3,t4}]}` |
| POST | `/batches/:id/finalize` | 核验并完成批次（幂等） |
| GET | `/batches/:id/report` | 逐条报告（含代表样本与可行区间） |
| GET | `/batches/:id/representative` | 代表样本与选择依据 |
| GET | `/batches/compare?a=&b=` | 比较两个批次 |
| GET | `/batches/:id/export` | 导出（含原时间戳与规则版本） |

错误响应统一为 `{"error":{"code","message"}}`。

## CLI

```bat
node dist\src\cli.js create-pair --client A --server B
node dist\src\cli.js new-batch --pair <pairId>
node dist\src\cli.js import --batch <batchId> --file records.json
node dist\src\cli.js verify --batch <batchId>       :: 核验并完成
node dist\src\cli.js report --batch <batchId>       :: 逐条报告
node dist\src\cli.js representative --batch <batchId>
node dist\src\cli.js compare --a <id1> --b <id2>
node dist\src\cli.js export --batch <batchId> --out out.json
```

`records.json` 格式：`[{"seq":0,"t1":"...","t2":"...","t3":"...","t4":"..."}, ...]`。
CLI 逐条展示：客户端总耗时 `(T4-T1)`、服务端处理时间 `(T3-T2)`、网络往返时延、
偏移精确分数与近似值、真实偏移可行区间。

## 测试覆盖

`npm test` 共 17 个用例：公式独立核对、对称路径中点等于真实偏移、不对称路径真实偏移
落在区间内、零网络延迟、服务端负偏移、超过安全整数的时间戳、奇数半纳秒分数、
负网络时延、同编号冲突与幂等、四戳同时平移不变性、只平移服务端两戳、最小延迟平局规则、
失败记录不参与代表选择、全部无效不发布估计、重启后读取一致、旧批次冻结、导出内容。

## 已知限制

- 依赖 Node 内置实验性模块 `node:sqlite`（Node >= 22.5，建议 >= 24），启动时会有
  ExperimentalWarning 提示；进程退出时可能打印无害的断言提示，不影响数据完整性。
- 单批次上限 10000 条、时间戳最多 30 位十进制；HTTP 服务仅监听 `127.0.0.1`。
- 不做滤波/长期漂移校准，不做在线监控与图形界面。
