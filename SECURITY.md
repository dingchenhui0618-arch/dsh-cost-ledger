# 安全模型 / Security model

这份文档说明 **dsh-cost-ledger** 截获什么、记下什么、不记什么、写到哪里，以及它那本
"账"为什么能当证据、哪里不能。它从实现（`src/host.js`、`src/ledger.js`、`src/prices.js`、
`src/report.js`、`src/cli.js`）里读出来；**如果文档和代码不一致，以代码为准，那说明这份
文档是个 bug。**

> 一句话：它在 `llm/stream` 这个 waterfall 上旁听每一次模型调用，把 **provider / model /
> 会话 id / token 数 / 按本地价目表算出的 nano-CNY** 追加写进 `$DSH_HOME/cost-ledger.jsonl`。
> **它不记录 prompt、不记录回答、不联网**；代价是"这笔钱花在什么内容上"它答不了。

## 信任边界

插件跑在 DSH 宿主进程里，`inject: ['webServer']`，用 `ctx.on('llm/stream', …)` 包住下游
流（`src/host.js` 的 `capture`）。

| 表面 | 谁触发 | 这一层有没有鉴权 |
| --- | --- | --- |
| `llm/stream` 监听 | 宿主里每一次流式模型调用 | 没有独立鉴权；这是宿主事件 |
| 面板路由 `/dsh-cost-ledger`（`ctx.webServer.register`，prefix） | 能访问 DSH web server 的人 | **没有自己的 token**；边界是宿主 web server |
| CLI `bin/cost-ledger.mjs` | 你自己在终端跑 | 普通进程权限；`--out` 想写哪就写哪 |

**视为不可信输入的**：

- **`llm/stream` 的 options**：`provider`、`model`、`sessionId`、`purpose` 都是字符串，
  记录时截断（120/200/200/40 字符），缺 session 时归到 `unattributed`；
- **账本文件本身**：每行都要过 `normalizeRecord`——字段类型不对、成本四项之和不等于
  `costNano`、缺 session/provider/model 的行**直接丢弃**（计数在 `skipped` 里），不会让
  一个坏行把整个面板打挂；
- **账单文件**：JSON 解析失败时 `billError` 会有值，账本照常可读；
- **HTTP 请求**：body 上限 1 MiB；`scope`/`key`/`amountCny` 都做白名单与正则校验
  （金额必须是非负十进制、最多 9 位小数）；查询参数只认 `format=csv|json`、
  `scope=hour|day|session`、`detail`、`dryRun`。

## 它记什么、不记什么

一次调用只写**一行 JSONL**，字段是：

```
v, id, at, hour, day, session, provider, model, purpose(≤40字符),
inputTokens, outputTokens, cacheHitTokens, cacheWriteTokens, reasoningTokens,
usageSource(adapter|estimated|missing), priced, priceTier, priceModel,
costInputNano, costCacheHitNano, costCacheWriteNano, costOutputNano, costNano,
status(ok|error|aborted|interrupted|ended), finish, ms, error(≤300字符)
```

- **没有 prompt，没有回答，没有工具参数**——只有 `purpose` 这个 40 字符的标签（宿主传
  什么就记什么）；
- `error` 最多 300 字符，是上游错误信息，可能包含内部地址或路径；
- token 数优先用 adapter 的 `usage` 块；没有时用**估算**（中文按 0.6 token/字、ASCII 按
  0.3）并标 `usageSource: 'estimated'`——估算值能和真实值差多少，面板上会分开计数；
- 价格来自内置价目表（`src/prices.js`，DeepSeek 官方页 2026-10-19 抓取，含峰谷与 2026
  法定节假日）或你给的 `pricesPath`/`prices` 配置；未知 provider/model **不猜价**，
  `priced: false`、成本记 0，并在聚合里单独计 `unpricedCalls`；
- 成本在调用时冻结：之后改价目表**不会重写历史**。

## 它写什么

只写自己的两个文件（`ledgerPath`/`billsPath` 可配）：

```
$DSH_HOME/cost-ledger.jsonl          # append-only，一次调用一行
$DSH_HOME/cost-ledger-bills.json     # 你手填的账单（scope|key → 金额）
```

- 目录不存在就 `mkdirSync(recursive)` 建；账本是 `appendFileSync`，**只追加、不改写、不删除**，
  没有轮转、没有保留上限（磁盘上会一直长）；
- 账单文件整体重写（`writeFileSync`），只保存你手填的数字与备注；
- 面板的 `GET /dsh-cost-ledger/export` **只读账本、把结果放进响应**，不写文件；写文件只发生
  在 CLI 的 `--out`（`src/cli.js`，`mkdirSync(dirname)` 后写）——那是你自己在终端做的事。

## 网络与遥测

- `src/` 里没有 `fetch`/`http`/`https`/`spawn` 调用；
- 没有遥测、没有上报、没有自动对账。你手填的平台账单不会被拿去请求任何平台接口。

## 路由

- `GET /dsh-cost-ledger/state`：聚合、最近调用、账单、价目表来源、捕获计数；
- `GET /dsh-cost-ledger/export`：`format=json|csv`、`scope`、`detail`、`dryRun`
  （dry-run 只返回预览，不返回完整数据）；
- `POST /dsh-cost-ledger/bill`：`set`（含 `amountCny: null` 删除）——写账单文件；
- 其它方法/路径 404。**没有额外鉴权**，和这个 profile 里其他客户端插件一样。

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **只记元数据**：没有 prompt/回答，所以"哪次调用最贵"能答，"为什么贵"只能靠 session id
   自己去翻会话。
2. **估算偏差**：adapter 不给 usage 时用字符数估算，`usageSource: 'estimated'` 是可查的，
   但它不是计费依据。
3. **价目表会过期**：内置表是 2026-10-19 的快照，峰谷时段与节假日写死；官方调价后需要你
   通过 `pricesPath` 覆盖，插件不会自己联网更新。
4. **未知模型不猜价**：宁可 `priced: false`，也不套一个相似模型的价格。
5. **账本无上限、无轮转**：长期常驻会一直追加；清理需要你自己动手（删文件不影响已生成的
   导出）。
6. **手填账单只是手填**：它不会去平台拉真实账单，也不校验你填的数字；`diff` 是"你以为的
   和平台收的"的差，不是对账结论。
7. **没有加密、没有访问控制**：`$DSH_HOME` 下的 JSONL 是本机明文；同用户的其他进程可读。
8. **会话聚合按字符串**：`session` 是宿主给的 id，插件不校验它是否真实存在；`unattributed`
   是一个真实的桶，不是错误。
9. **已知测试缺陷（不是产品行为）**：`test/host.test.mjs` 里两条账单用例把日期写死成
   `2026-10-19`，过了那天就必然失败（记录落在当天，账单落在 10-19，`joinBills` 不会为没有
   记录的日期造行）。CI 用 `--test-skip-pattern` 跳过这两条并保留其余 46 条；修法是用
   `dayKey(Date.now())` 代替字面日期，等维护者决定。

## 明确不算漏洞的

- **账本里有 session id 和模型名**：这是记账的最小信息，见限制 1；
- **面板能看到别人的调用**：DSH 的账本按 `DSH_HOME` 分，不分用户；同机同用户的边界本来
  就是共享的；
- **手填账单能被任何人改**：路由没有独立鉴权，见上面"路由"；
- **估算 token 和平台账单对不上**：估算与账单是两列，本来就该对不上，`diff` 就是给这个
  用的；
- **导出的 CSV 能在 Excel 里执行公式**：不是漏洞，`csvCell` 对以 `= + - @`、制表符、回车
  开头的单元格前置单引号，并对引号/逗号/换行做 RFC4180 转义；`purpose` 里就算塞了
  `=cmd`，导出后也是文本。

## 报告漏洞

用 GitHub 的私密渠道：
<https://github.com/dingchenhui0618-arch/dsh-cost-ledger/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但我会读、会修，修完会在 CHANGELOG 里写清影响
范围与修复版本。请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护 `master` 上的最新一版（当前 `0.1.0`，见 `package.json`）。npm 上的
`dsh-cost-ledger`（`0.1.4`）**不是这个项目**——它的 repository 指向别人，本仓库没有发布到
npm，所以没有 npm 渠道的旧版本需要支持。
