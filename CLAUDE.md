# cn-owlpin-report-mcp

回答请使用中文；代码注释使用中文；标识符、MCP 工具名 / 描述 / 错误信息、git commit message 用英文。

小鸮钉台「出报告」的 MCP 入口（EdgeOne Makers 边缘函数，`report.owlpin.cn/mcp`），用法与部署见 README.md。

## 边界

- **只做 MCP 协议和工具说明，不存数据、不做校验**：`create_report` 原样转给 payload `POST /api/reports`，报告的格式说明取 payload `GET /api/reports/format`。组件目录、spec 清洗、限流、8 小时清空都在 `../cn-owlpin-payload`（`src/aiApps/report/`、`src/collections/Reports/`），改规则改那边，这里不镜像。
- 工具的名字 / 描述 / inputSchema / outputSchema / annotations 定义在 `edge-functions/mcp.js` 的 `TOOLS`。改动后在 WorkBuddy 里会立刻生效（连接器不用重新提审），但要考虑已经在用的客户端。
- 协议约定与 payload 主 MCP（`src/integrations/mcp/server.ts`）一致：stateless JSON-RPC 2.0、协议版本表、notification 回 202、工具失败返回 `isError: true` 而不是 JSON-RPC error、成功必带 `structuredContent`。**不鉴权、不回 401**（客户端看到 401 会走 OAuth）。拒绝带 `Origin` 的浏览器请求。
- 转给 payload 时**不带 Origin**（payload 会拒），带 `Accept-Language: en`（错误保持英文），带 `X-Owlpin-Client`（来源统计）；有平台给的客户端 IP 且配了密钥时带 `X-Report-Client-Ip` + `X-Report-Relay-Secret`，payload 校验密钥后用它限流。客户端 IP 只取 `request.eo.clientIp`，不读客户端可伪造的请求头。

## EdgeOne 边缘函数约束

- V8 运行时（类似 Cloudflare Workers）：**不能 import npm 包**、不能用 Node 内置模块；没有 `Response.json()`（用 `new Response(JSON.stringify(...))`）；响应头用普通对象。
- 环境变量在 `context.env`（`PAYLOAD_URL`、`REPORT_RELAY_SECRET`），不是 `process.env`。
- 请求体上限 1 MB，CPU 200 ms（不含 I/O 等待）；代码包 5 MB。
- 路由按 `edge-functions/` 目录生成：`edge-functions/mcp.js` → `/mcp`。
- 纯 JS（`// @ts-check` + JSDoc），`pnpm typecheck` 用 tsc checkJs 检查；逻辑放在可测试的 `handleMcpRequest(request, deps)`，`onRequest` 只负责组装依赖。

## 常用命令

```bash
pnpm test / pnpm typecheck / pnpm format
pnpm run deploy    # edgeone makers deploy（pnpm deploy 是内置命令，要加 run）
```
