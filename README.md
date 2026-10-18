# DSH Community Plugin Index (format 1)

一个可直接添加到 **DeepSeek Harness → 插件 → 发现（Discover）→ 添加索引源** 的插件市场索引文件。

An addable plugin-market index for **DeepSeek Harness → Plugins → Discover → Add index source**.

## 用法 / Usage

添加这个地址作为索引源 / Add this URL as an index source:

```
https://<user>.github.io/<repo>/index.json      # GitHub Pages（推荐，application/json）
https://raw.githubusercontent.com/<user>/<repo>/main/index.json   # 备用（raw，无重定向）
```

内容 / Contents：**2951 个插件 / 12613 个版本**，23 个分类、11 个能力标签，排序键 `stars`、`downloads`。

## 生成方式 / How it was generated

1. 取上游目录 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)（5786 条，第三方聚合）。
2. 对其中发布到 npm 的 2967 条，逐个抓取 npm registry packument，取真实版本号、发布时间、`engines.dsh`。
3. 按 format 1 规格生成 `index.json`，并用官方发布的校验库 `@deepseek-ai/dsh-plugin-market-index` 逐条校验（0 错误）。

统计见 [stats.json](stats.json)。未收录的 16 条是 npm 上没有声明 `dsh` 字段的可用版本；另有 2819 条只存在于 GitHub、没有 npm 包，本文件暂不收（需 git 源形式）。

## 重要说明 / Important

- **这不是官方索引源。** DeepSeek 官方文档明确写着 "DSH ships no index source."，官方插件由应用内置（卡片显示 *Provided by DSH*）。本文件是社区自建索引。
- **索引只是目录，不是安全审计。** 官方原文："Markets are third-party content. A market chooses each plugin's title, description, icon, author, and source; DSH checks the file format but not those claims." 第三方插件会以你的用户权限运行代码，包括安装期脚本；安装前的确认对话框里会显示确切的安装规格（npm 包与 registry，或 git 仓库与 commit），请自行判断。
- 目录数据、stars、下载量均来自第三方抓取与 npm registry，**未经核实**，可能过期或有误。
- GitHub Pages 对文件大小有 100 MiB 限制（本文件约 4.2 MiB）；索引上限默认 128 MiB，服务需返回 2xx 且**不重定向**。

## 本地重新生成 / Regenerate

索引由本地脚本从公开数据重新生成；发布时只需替换 `index.json` 与 `stats.json` 后提交即可。
