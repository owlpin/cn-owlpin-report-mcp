# cn-owlpin-report-mcp

小鸮钉台「出报告」的 MCP 入口，部署在腾讯 EdgeOne Makers 的边缘函数上：`https://report.owlpin.cn/mcp`。

外部平台（WorkBuddy 连接器等）里的模型把对话整理成小鸮钉台的页面 spec，调这里的 `create_report`，拿到公开报告页 `https://app.owlpin.cn/b/<token>`。
这里**不存数据**：校验、存储、8 小时清空、限流、下架都在 payload（`../cn-owlpin-payload` 的 `src/collections/Reports/`，接口见其 `docs/api.md` 的 Reports 一节）。

```
WorkBuddy ──MCP──▶ report.owlpin.cn/mcp（本项目，无状态）
                    ├ get_report_format → GET  payload /api/reports/format（缓存 5 分钟）
                    └ create_report     → POST payload /api/reports
                                          带 X-Report-Client-Ip / X-Report-Relay-Secret / X-Owlpin-Client
报告页 app.owlpin.cn/b/<token>（cn-owlpin-web）读 payload GET /api/reports/public/<token>
```

## 目录

| 路径 | 说明 |
| --- | --- |
| `edge-functions/mcp.js` | 唯一的边缘函数（路由 `/mcp`）：MCP 协议 + 两个工具，纯 JS、无依赖、不需要构建 |
| `test/mcp.test.js` | vitest，mock fetch 测协议、转发的请求头 / body 和各种上游响应 |
| `edgeone.json`、`public/` | 静态资源只发 `public/`（只有一个禁止抓取的 robots.txt），仓库里的其他文件不会被公开 |
| `connector/` | WorkBuddy 连接器包（`connector-meta.json`、`mcp.json`、`icon.svg`、`skills/owlpin-report/SKILL.md`），打包后在 WorkBuddy 开放平台提交审核 |

## 开发

```bash
pnpm install
pnpm test
pnpm typecheck   # tsc checkJs（JSDoc 类型）
```

## 部署（EdgeOne Makers）

1. 安装 CLI 并登录：`npm i -g edgeone@latest`，`edgeone login`（选「中国站」）。
2. 首次部署：`pnpm run deploy`（即 `edgeone makers deploy -n cn-owlpin-report-mcp`），项目不存在时会自动创建。
3. 控制台 → 项目设置 → 环境变量：
   - `PAYLOAD_URL`：默认 `https://payload.owlpin.cn`，一般不用设
   - `REPORT_RELAY_SECRET`：与 payload 的 Worker secret `REPORT_RELAY_SECRET` 相同（`wrangler secret put REPORT_RELAY_SECRET --env production`）。不设的话 payload 只能看到 EdgeOne 的出口 IP，所有用户共用一个限流桶
4. 控制台 → 域名管理：绑定 `report.owlpin.cn`，加速区域选中国大陆（owlpin.cn 已备案），按提示在 DNSPod 加 CNAME。
5. 之后发版：`pnpm run deploy`（`pnpm deploy` 是 pnpm 内置命令，要加 run）。

上线后验证：

```bash
npx @modelcontextprotocol/inspector   # Streamable HTTP，URL 填 https://report.owlpin.cn/mcp
```

依次调 `get_report_format`、`create_report`，打开返回的 `/b/<token>`；在 payload 后台确认报告的 `source` 是 `workbuddy`（URL 带 `?client=workbuddy` 时）。

## WorkBuddy 连接器

`connector/mcp.json` 指向 `https://report.owlpin.cn/mcp?client=workbuddy`（来源用 URL 参数标记：`staticHeaders` 要 WorkBuddy 5.0 以上）。
在 WorkBuddy 本地加载 `connector/` 实测「把上面的讨论出个报告」能触发、链接能打开，再打包提交开放平台审核。字段说明见 https://open.workbuddy.cn/docs/connector 与 /docs/skill。
