# DSH Community Plugin Index (format 1)

[![Update index](https://github.com/dingdang66686/dsh-market-index/actions/workflows/update-index.yml/badge.svg)](https://github.com/dingdang66686/dsh-market-index/actions/workflows/update-index.yml)
[![Validate index](https://github.com/dingdang66686/dsh-market-index/actions/workflows/validate.yml/badge.svg)](https://github.com/dingdang66686/dsh-market-index/actions/workflows/validate.yml)

一个可直接添加到 **DeepSeek Harness → 插件 → 发现（Discover）→ 添加索引源** 的插件市场索引文件。索引由 GitHub Actions **每 12 小时自动重建并校验**，无需人工维护。

An addable plugin-market index for **DeepSeek Harness → Plugins → Discover → Add index source**. GitHub Actions rebuilds and validates it every 12 hours.

## 用法 / Usage

添加这个地址作为索引源 / Add this URL as an index source:

```
https://raw.githubusercontent.com/dingdang66686/dsh-market-index/main/index.json  # 最及时：push 后几秒内生效
https://cdn.jsdelivr.net/gh/dingdang66686/dsh-market-index@main/index.json       # 全球 CDN，application/json
https://dingdang66686.github.io/dsh-market-index/index.json                       # 需在 Settings → Pages 开启
```

已实测：raw 地址返回 `200`、**不重定向**，与仓库中的 `index.json` 逐字节一致（sha256 校验），并用官方解析器重新校验通过。**想要最新一版就用第一条**：jsDelivr 对 `@main` 的长期缓存最长 12 小时，每次流水线都会调用它的 purge 接口刷新，但 purge 也可能被限流，那时它会继续返回上一版。CDN 地址带 `application/json`，有些环境下读取更省事。

内容 / Contents：**2951 个插件 / 12634 个版本**，23 个分类、11 个能力标签，排序键 `stars`、`downloads`。实时统计见 [stats.json](stats.json)，最近一次运行见 [run-report.json](run-report.json)。

## 自动更新 / Automated updates

`.github/workflows/update-index.yml` 在两种情况下运行 / runs on:

| 触发 / Trigger | 说明 / What it means |
| --- | --- |
| `schedule: 17 3,15 * * *`（UTC） | 每天 03:17 与 15:17 UTC，即北京时间 11:17 与 23:17。cron 是 UTC，且可能延迟几分钟到几十分钟。 |
| `workflow_dispatch` | 手动点 **Run workflow** 立即重建。 |
| `push` 到 `main`（改到 `tools/**`、`package.json`、`pnpm-lock.yaml`、工作流本身时） | 改了抓取/生成逻辑就自动重建一次。 |

每次运行的流水线 / Pipeline of each run:

1. `node tools/crawl-packuments.mjs --fresh` — 抓上游目录，并逐个请求 npm registry 的 packument（约 2967 个包，跑一次约 2–5 分钟）。
2. `node tools/build-index.mjs` — 按 format 1 规格生成 `index.json` 与 `stats.json`。**内置两道保险**：抓取缺失过多（`noCache` 超阈值）或插件总数比上次缩水超过 10% 时，直接以非零退出码拒绝发布，不会把残缺索引推上线。
3. `node tools/validate-index.mjs` — 用官方发布的 `@deepseek-ai/dsh-plugin-market-index` 解析器逐条校验（字节数上限、`format === 1`、`localizedText` 必须含 `en`、版本必须是精确 SemVer、git 源 commit 必须是 40 位小写 hex……）。
4. `node tools/run-report.mjs` — 写 `run-report.json`，并输出到 Actions 的 Job Summary。
5. `node tools/commit-decision.mjs` 决定这次要不要提交：`index.json` 的字节变了就提交；没变、且仓库里已提交的 `run-report.json` 还很新（< 7 天）就跳过提交。原因：`stats.json` 与 `run-report.json` 带时间戳，无条件提交会变成每天两次的无意义提交；而完全不提交又可能让 GitHub 因为 60 天无活动停掉定时任务，所以保留“最多 7 天一次”的心跳。提交信息带 `[skip ci]`，避免这种纯数据推送再触发一遍 `Validate index`（同一次运行末尾的 `verify` 已经在做线上校验）。
6. 校验发布结果：对 **raw 地址**断言 `200`、**不重定向**、字节数与 sha256 与本次构建完全一致。期望值取自构建步骤记录的摘要（`steps.digest.outputs`），而不是 `verify` 自己那份 checkout —— 否则在“刚推送完”的运行里会拿上一版做比较，恰好在最需要校验的时候误报。jsDelivr 与 Pages 两个地址也会被检查，但只产出 `::warning::` 注解、不影响运行结论：它们的时效由第三方缓存决定（jsDelivr 缓存 `@main` 最长 12 小时，purge 也可能被限流），把运行变红并不会让它们更快收敛。purge 步骤会重试 3 次并打印返回内容，便于排查。
7. 顺带把 `index.html`、`index.json`、`stats.json`、`run-report.json` 发布到 GitHub Pages（可选步骤，见下）。

`.github/workflows/validate.yml` 是轻量门禁：数据或工具一有改动就跑一遍解析校验，并（在非 PR 的情况下）确认 raw 地址仍然返回这些字节；CDN 与 Pages 只作提示。

### 工作流实现细节 / Workflow implementation notes

- 运行环境：`ubuntu-latest` + Node 24；用到的 action 全部是 node24 运行时的主版本（`actions/checkout@v5`、`actions/setup-node@v5`、`pnpm/action-setup@v6`、`actions/configure-pages@v6`、`actions/upload-pages-artifact@v5`、`actions/deploy-pages@v5`）。pnpm 版本在 `pnpm/action-setup` 里固定为 `11.28.5`，与仓库中的锁文件一致。
- 安装依赖用 `pnpm install --frozen-lockfile --config.node-linker=hoisted`：锁文件固定了解析库的完整性哈希，`hoisted` 布局与本地验证过的布局一致。
- ⚠️ pnpm 11 默认不安装“发布时间不足 24 小时”的版本（`minimum-release-age=1440` 分钟）。`pnpm-workspace.yaml` 里已经为 `@deepseek-ai/*` 两个包写了两条 `minimumReleaseAgeExclude`；将来升级 `@deepseek-ai/dsh-plugin-market-index`（例如 DSH 运行时离开 `0.2.1-rc.2` 时）如果 `pnpm install` 报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，把新版本号加进那份白名单即可。不要为了绕开它把 `minimum-release-age` 设为 0，那会去掉一道供应链防护。
- `verify` 用 `git show HEAD:<文件>` 取上一次提交的内容（1 层浅克隆里同样可用），不使用 `git log` 这类历史查询——浅克隆下 `git log -- <文件>` 可能什么都查不到。
- 构建与校验之间的“期望值”通过 job output 传递：`build` 把 `sha256sum`/`wc -c` 的结果写进 `steps.digest.outputs`，`verify` 用 `--expect-sha256=… --expect-bytes=…` 消费它，并保留 `--file=` 作为可选交叉校验（若 checkout 与记录值不一致会直接报 `INVALID`）。这样 `verify` 的结论只取决于“线上字节是否等于刚构建的字节”。

### 需要做的两件一次性设置 / Two one-time settings

1. **Actions 写权限**：Settings → Actions → General → Workflow permissions → **Read and write permissions**。默认可能只有读权限，那样流水线会在推送那一步失败并给出明确报错。
2. **GitHub Pages（可选）**：Settings → Pages → Source 选 **GitHub Actions**。不开启也不影响使用 —— raw 与 jsDelivr 两个地址本来就能用；未开启时 Pages 那一步会失败但不影响整体（`continue-on-error`）。

### 已知限制 / Caveats

- **GitHub 会在仓库 60 天没有任何活动后自动停掉定时工作流。** 本流水线保留“最多 7 天一次”的心跳提交（见上一步），所以只要流水线还在跑，仓库就不会累积到 60 天无活动；若真被停掉，去 Actions 页面点一次 **Enable workflow** 即可。心跳提交带 `[skip ci]`，因此这段时间 `Validate index` 不会因为心跳提交而运行。
- 定时任务是尽力而为：高负载时可能延迟数十分钟，极端情况下会跳过某次。
- ⚠️ `@main` 在 jsDelivr 上最长缓存 12 小时，purge 接口也可能被限流；此时 CDN 会继续返回上一版，而 raw 地址（约 5 分钟缓存）早已是新版。流水线只在 raw 地址上设卡，CDN 落后时给一条 warning 注解而不是让运行失败——这也是为什么**推荐用 raw 地址**作为索引源。
- 索引内容会随上游目录与 npm registry 变化而变化，不保证与上一次逐字节相同。

## 生成方式 / How it is generated

1. 取上游目录 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)（5786 条，第三方聚合）。
2. 对其中发布到 npm 的 2967 条，逐个抓取 npm registry packument，取真实版本号、发布时间、`engines.dsh`。
3. 按 format 1 规格生成 `index.json`，并用官方发布的校验库 `@deepseek-ai/dsh-plugin-market-index` 逐条校验（0 错误）。

每个插件最多收录 6 个版本：优先取“未废弃且声明了 `dsh` 字段”的版本（由新到旧），否则退回目录里标注的版本。统计见 [stats.json](stats.json)。未收录的 16 条是 npm 上没有声明 `dsh` 字段的可用版本；另有 2819 条只存在于 GitHub、没有 npm 包，本文件暂不收（需 git 源形式）。

## 本地运行 / Run locally

需要 Node 20+ 与 pnpm（CI 用 pnpm 11.28.5，锁文件已提交）:

```bash
pnpm install --frozen-lockfile --config.node-linker=hoisted

pnpm run pipeline   # = crawl --fresh && build && validate && report
# 或者逐步执行：
node tools/crawl-packuments.mjs --fresh            # 抓 packument（缓存到 cache/，加 --limit=N 可只抓前 N 个）
node tools/build-index.mjs                         # 生成 index.json + stats.json
node tools/validate-index.mjs --file=index.json    # 用官方解析器校验（--url= 可换索引地址）
node tools/run-report.mjs                          # 生成 run-report.json
node tools/check-live.mjs --file=index.json \
  --require=https://raw.githubusercontent.com/dingdang66686/dsh-market-index/main/index.json
```

生成结果是确定性的：同一份上游数据会产出逐字节相同的 `index.json`（`stats.json.generatedAt` 与 `run-report.json` 除外）。`cache/`、`catalog.json`、`node_modules/`、`_site/` 都不入库。

`node tools/commit-decision.mjs --index-changed=0 --previous-report=<上次提交的 run-report.json>` 是纯计算脚本（自己不会调用 git），可用它复现“这次要不要提交”的判断：输出以 `commit:` 或 `skip:` 开头。


## 重要说明 / Important

- **这不是官方索引源。** DeepSeek 官方文档明确写着 "DSH ships no index source."，官方插件由应用内置（卡片显示 *Provided by DSH*）。本仓库是社区自建索引。
- **索引只是目录，不是安全审计。** 官方原文："Markets are third-party content. A market chooses each plugin's title, description, icon, author, and source; DSH checks the file format but not those claims." 第三方插件会以你的用户权限运行代码，包括安装期脚本；安装前的确认对话框里会显示确切的安装规格（npm 包与 registry，或 git 仓库与 commit），请自行判断。
- 目录数据、stars、下载量均来自第三方抓取与 npm registry，**未经核实**，可能过期或有误。
- GitHub Pages 对文件大小有 100 MiB 限制（本文件约 4.2 MiB）；索引上限默认 128 MiB，服务需返回 2xx 且**不重定向**。
