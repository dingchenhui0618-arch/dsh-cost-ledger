# Changelog

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：写清 `llm/stream` 旁听记哪些字段（不记 prompt/回答）、账本 append-only
  写到 `$DSH_HOME/cost-ledger.jsonl`、路由没有独立 token、未知模型不猜价、CSV 公式注入已转义，
  以及两条日期写死在 `2026-10-19` 的账单测试。
- 新增 `.github/workflows/ci.yml`：ubuntu + windows × node 22/24，构建后断言 `lib/` 与
  `src/` 一致；测试用 `--test-skip-pattern` 跳过上述两条日期用例，其余 46 条照跑。
- README 顶部加 CI 与 license badge，引言后加一句 star 引导。没有加 npm badge——npm 上的
  `dsh-cost-ledger` 是别人的包，本仓库没有发布。

## 0.1.0

首个版本：

- 在 `llm/stream` waterfall 上记录每次流式模型调用：provider、model、session、输入/输出/缓存命中/缓存写入 token、用量来源、状态、耗时。
- 按显式价目表把 token 换算成整数 nano-CNY；官方 DeepSeek 价格表含峰谷与 2026 法定节假日，未知 provider/model 不猜价。
- 按小时、日、会话三档聚合；账本 append-only JSONL，费用在调用时冻结。
- 手填官方账单（hour/day/session）与本地估算并列，导出 `actual_cny` / `diff_cny` / `diff_pct`。
- `export --json|--csv`、`--detail`、`--dry-run`、`--since/--until`、`--out`；另有 `bill set/list/delete`、`prices` 命令。
- 对话视图「成本账」面板：统计、聚合表、最近调用、账单表单、导出与 dry-run 预览、价目表来源。
- host/client 双半区；零运行时依赖、零构建期依赖；48 个 `node --test` 测试。
