// @ts-check
/**
 * 小鸮钉台报告 MCP 入口：`POST /mcp`（Streamable HTTP，stateless JSON-RPC 2.0），跑在 EdgeOne Makers 边缘函数上。
 *
 * 这里只有 MCP 协议和工具说明，**不存任何数据**：
 * - `get_report_format` 取 payload 的 `GET /api/reports/format`（Cache API 缓存 5 分钟）
 * - `create_report` 转给 payload 的 `POST /api/reports`，校验、存储、8 小时清空、限流、下架都在那边
 *   （cn-owlpin-payload `src/collections/Reports/`，接口文档见其 `docs/api.md` 的 Reports 一节）
 *
 * 协议细节与原先 payload 上的实现一致：不鉴权、不回 401（WorkBuddy 等客户端看到 401 会走 OAuth），
 * 工具失败用 `isError: true` 而不是 JSON-RPC error，notification 回 202，拒绝带 Origin 的浏览器请求。
 *
 * 运行时约束（EdgeOne 边缘函数，V8）：不能 import npm 包，没有 `Response.json()`，响应头用普通对象，
 * 环境变量在 `context.env`，客户端 IP 在 `request.eo.clientIp`；请求体上限 1 MB、CPU 200 ms。
 */

/**
 * @typedef {object} Deps
 * @property {typeof fetch} fetch
 * @property {string} payloadUrl payload 的地址（生产 https://payload.owlpin.cn）
 * @property {string} relaySecret 转发真实 IP 用的密钥（与 payload 的 REPORT_RELAY_SECRET 一致），没配为 ''
 * @property {string | null} clientIp 平台给的客户端 IP（request.eo.clientIp）
 * @property {() => Promise<Cache | null>} openCache 按需打开 Cache API（只有 get_report_format 用）
 */
/** @typedef {{ content: Array<{ type: 'text', text: string }>, isError?: boolean, structuredContent?: Record<string, unknown> }} ToolResult */

const SERVER_INFO = { name: 'owlpin-report', version: '1.0.0' }

// 下面几个常量手抄自 payload，改那边时同步（MIRROR）：
// - SUPPORTED_PROTOCOL_VERSIONS ← src/integrations/mcp/server.ts
// - REPORT_THEMES ← src/aiApps/appThemes.ts 的 APP_THEME_IDS
// - REPORT_TTL_HOURS ← src/aiApps/report/constants.ts（只用于说明文案，实际有效期以返回的 expiresAt 为准）
// - MAX_REQUEST_BYTES ← REPORT_MAX_BODY_BYTES + JSON-RPC 外壳余量

/** create_report 可选的主题（daisyUI 主题名），写进 inputSchema 的 enum，让客户端和模型只在这些里选 */
const REPORT_THEMES = [
  'light',
  'dark',
  'cupcake',
  'bumblebee',
  'emerald',
  'corporate',
  'synthwave',
  'retro',
  'cyberpunk',
  'valentine',
  'halloween',
  'garden',
  'forest',
  'aqua',
  'lofi',
  'pastel',
  'fantasy',
  'wireframe',
  'black',
  'luxury',
  'dracula',
  'cmyk',
  'autumn',
  'business',
  'acid',
  'lemonade',
  'night',
  'coffee',
  'winter',
  'dim',
  'nord',
  'sunset',
]

/** 新 → 旧 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const REPORT_TTL_HOURS = 8

const MAX_REQUEST_BYTES = 256 * 1024 + 16 * 1024

/** 转发给 payload 的超时；MCP 客户端（WorkBuddy）自己的超时是 30 秒 */
const UPSTREAM_TIMEOUT_MS = 15_000

/** get_report_format 的缓存时长 */
const FORMAT_CACHE_SECONDS = 300

const GENERIC_TOOL_ERROR = 'The tool failed unexpectedly. Retry once; if it keeps failing, contact support@owlpin.cn.'

const ERR_PARSE = -32700
const ERR_INVALID_REQUEST = -32600
const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603

const INSTRUCTIONS = `Owlpin turns a conversation into a polished, shareable report page. Flow: call get_report_format, write the page spec in that format from what was discussed (no invented data, no links), call create_report, then give the user the returned url. Reports are public to anyone with the link and are deleted ${REPORT_TTL_HOURS} hours after creation.`

const TOOLS = [
  {
    name: 'get_report_format',
    description:
      'Get the page format for create_report: the JSON spec shape, the component catalog with every prop, an example and the content rules. Call it once before writing a report spec.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        catalogVersion: { type: 'number' },
        format: { type: 'string' },
        ttlHours: { type: 'number' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_report',
    description: `Publish a structured report page from the conversation and get its link. Use it when the user asks to turn the discussion or material into a report (e.g. "出报告", "生成报告", "整理成报告", "make a report").
Call get_report_format first and write the "spec" exactly in that format (a Page root, a Hero first, then Sections built from the listed components), and pick a "theme" that fits the topic. Do not include links. The page is public to anyone with the link and is deleted automatically ${REPORT_TTL_HOURS} hours after creation.
On success reply with the returned url as-is and mention that it expires in ${REPORT_TTL_HOURS} hours (the user can download a PDF from the page). If the call fails with issues, fix the spec accordingly and call it again (at most twice).`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        spec: {
          type: 'object',
          description:
            'The page: { "root": "<page id>", "elements": { "<id>": { "type", "props", "children" } } }. Components and props are listed by get_report_format.',
        },
        theme: {
          type: 'string',
          enum: REPORT_THEMES,
          description:
            'Optional color theme of the page and its PDF: one of the themes listed by get_report_format (e.g. corporate, nord, cupcake). Pick one that fits the topic; default light.',
        },
      },
      required: ['spec'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        expiresAt: { type: 'string', description: 'ISO time after which the report is deleted' },
        issues: { type: 'array', items: { type: 'string' } },
        theme: { type: 'string', description: 'Theme actually used (unknown themes fall back to light)' },
        token: { type: 'string' },
        url: { type: ['string', 'null'], description: 'Public report page, e.g. https://app.owlpin.cn/b/<token>' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
]

/** snake_case 工具名 → 展示用标题（`create_report` → `Create report`），同 payload 的 toolTitle @param {string} name */
function toolTitle(name) {
  const [first = '', ...rest] = name.split('_').filter(Boolean)
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** @param {unknown} id @param {unknown} result */
function rpcResult(id, result) {
  return json({ jsonrpc: '2.0', id: id ?? null, result })
}

/** @param {unknown} id @param {number} code @param {string} message @param {number} [status] @param {unknown} [data] */
function rpcError(id, code, message, status = 200, data) {
  return json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } },
    status
  )
}

/** @param {string} text @returns {ToolResult} */
function failure(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** @param {unknown} requested */
function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0]
}

/** @param {string} text UTF-8 字节数（中文一个字 3 字节） */
function utf8Length(text) {
  return new TextEncoder().encode(text).length
}

/**
 * 调 payload，连响应体一起在超时内读完（只超时等响应头的话，payload 发完头卡住时会一直挂到客户端超时）。
 * 不用 AbortSignal.timeout：不确定边缘运行时有没有；fetch 不认 signal 时 Promise.race 兜底。
 * 返回状态码和解析后的 JSON（解析失败为 null）
 * @param {Deps} deps @param {string} path @param {RequestInit} init
 * @returns {Promise<{ status: number, body: any }>}
 */
async function callPayload(deps, path, init) {
  const controller = new AbortController()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`payload ${path} timed out`))
    }, UPSTREAM_TIMEOUT_MS)
  })
  const request = (async () => {
    const response = await deps.fetch(`${deps.payloadUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      // 网关错误页等非 JSON 响应
    }
    return { status: response.status, body }
  })()
  try {
    return /** @type {{ status: number, body: any }} */ (await Promise.race([request, timeout]))
  } finally {
    clearTimeout(timer)
  }
}

/** payload 的错误统一是 `{ error: { code, message, details? } }` @param {any} body */
function payloadError(body) {
  /** @type {{ code?: string, message?: string, details?: { issues?: unknown } }} */
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {}
  return error
}

/** @param {Deps} deps @param {string} cacheKey 本服务自己域名下的地址（边缘缓存不一定接受别的域名做 key） @returns {Promise<ToolResult>} */
async function getReportFormat(deps, cacheKey) {
  const cache = await deps.openCache()
  const cached = cache ? await cache.match(cacheKey).catch(() => undefined) : undefined
  /** @type {any} */
  let body = cached ? await cached.json().catch(() => null) : null
  if (!body) {
    const response = await callPayload(deps, '/api/reports/format', { headers: { Accept: 'application/json' } })
    if (response.status !== 200 || typeof response.body?.format !== 'string') {
      console.error('[report-mcp] format upstream', response.status)
      return failure(GENERIC_TOOL_ERROR)
    }
    body = response.body
    if (cache) {
      const copy = new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${FORMAT_CACHE_SECONDS}` },
      })
      await cache.put(cacheKey, copy).catch(error => console.error('[report-mcp] cache put failed', error))
    }
  }
  const { catalogVersion, format, ttlHours } = body
  return { content: [{ type: 'text', text: format }], structuredContent: { catalogVersion, format, ttlHours } }
}

/** @param {Record<string, unknown>} args @param {Deps} deps @param {string} source @returns {Promise<ToolResult>} */
async function createReport(args, deps, source) {
  const spec = args.spec
  if (spec === undefined || spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return failure('"spec" must be an object { root, elements }. Call get_report_format for the format.')
  }
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    // 错误提示保持英文（payload 按 Accept-Language 翻译）
    'Accept-Language': 'en',
    'X-Owlpin-Client': source,
  }
  // 真实客户端 IP：payload 只在密钥对上时才信任它。缺了的话 payload 只能按 EdgeOne 出口 IP 限流，
  // 所有用户共用一个桶（一个人刷满就都用不了），所以要在日志里喊出来。密钥只发给 https 地址
  if (deps.clientIp && deps.relaySecret && deps.payloadUrl.startsWith('https://')) {
    headers['X-Report-Client-Ip'] = deps.clientIp
    headers['X-Report-Relay-Secret'] = deps.relaySecret
  } else {
    console.error('[report-mcp] creating without the relayed client IP; all callers share one rate-limit bucket', {
      hasClientIp: Boolean(deps.clientIp),
      hasSecret: Boolean(deps.relaySecret),
      https: deps.payloadUrl.startsWith('https://'),
    })
  }
  // 主题原样转给 payload：认不认得、怎么回退都由 payload 决定
  const theme = typeof args.theme === 'string' && args.theme ? args.theme : undefined
  const response = await callPayload(deps, '/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify(theme ? { spec, theme } : { spec }),
  })
  console.info('[report-mcp] create_report', { source, status: response.status })

  if (response.status === 201 && response.body) {
    const created = /** @type {{ url: string | null, token: string, expiresAt: string, issues?: string[] }} */ (
      response.body
    )
    const issues = created.issues ?? []
    const notes = issues.length > 0 ? `\nSome parts were dropped:\n- ${issues.join('\n- ')}` : ''
    return {
      content: [
        {
          type: 'text',
          text: `Report published: ${created.url ?? created.token}\nIt is deleted automatically at ${created.expiresAt} (${REPORT_TTL_HOURS} hours).${notes}`,
        },
      ],
      structuredContent: { ...created, issues },
    }
  }

  const error = payloadError(response.body)
  if (response.status === 400) {
    const issues = Array.isArray(error.details?.issues) ? error.details.issues.map(String) : []
    const list = issues.length > 0 ? `\nIssues:\n- ${issues.slice(0, 30).join('\n- ')}` : ''
    return failure(
      `${error.message ?? 'Invalid report'}${list}\nFix the spec (see get_report_format) and call create_report again.`
    )
  }
  if (response.status === 429) {
    return failure(error.message ?? 'Too many requests, please try again later')
  }
  console.error('[report-mcp] create upstream', response.status, error.code)
  return failure(GENERIC_TOOL_ERROR)
}

/**
 * @param {Request} request
 * @param {Deps} deps
 * @returns {Promise<Response>}
 */
export async function handleMcpRequest(request, deps) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  // MCP 客户端都不是浏览器、不带 Origin；放行的话任意网页能用 text/plain 简单请求（不触发 CORS 预检）
  // 借访客的浏览器批量创建报告（payload 那边也会拒，这里先挡掉）
  if (request.headers.get('origin')) {
    return rpcError(null, ERR_INVALID_REQUEST, 'Browser requests are not allowed', 403)
  }
  // 先按字节检查再解析：分块传输时没有 Content-Length，只看请求头挡不住
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) {
    return rpcError(null, ERR_INVALID_REQUEST, 'Request too large', 413)
  }
  const raw = await request.text()
  if (utf8Length(raw) > MAX_REQUEST_BYTES) {
    return rpcError(null, ERR_INVALID_REQUEST, 'Request too large', 413)
  }

  /** @type {unknown} */
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return rpcError(null, ERR_PARSE, 'Invalid JSON')
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    /** @type {{ jsonrpc?: unknown }} */ (body).jsonrpc !== '2.0'
  ) {
    return rpcError(null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC request')
  }
  const { id, method, params } = /** @type {{ id?: unknown, method?: unknown, params?: Record<string, unknown> }} */ (
    body
  )
  if (typeof method !== 'string') {
    return rpcError(id, ERR_INVALID_REQUEST, 'Missing method')
  }

  const protocolVersion = request.headers.get('mcp-protocol-version')
  if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return rpcError(id, ERR_INVALID_REQUEST, 'Unsupported MCP protocol version', 400, {
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    })
  }
  if (method.startsWith('notifications/')) {
    return id === undefined || id === null ? new Response(null, { status: 202 }) : rpcResult(id, {})
  }

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        })

      case 'ping':
        return rpcResult(id, {})

      case 'tools/call': {
        const name = params?.name
        if (typeof name !== 'string' || !name) {
          return rpcError(id, ERR_INVALID_PARAMS, 'tools/call requires params.name (string)')
        }
        const rawArgs = params?.arguments
        if (rawArgs != null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
          return rpcError(id, ERR_INVALID_PARAMS, 'tools/call params.arguments must be an object')
        }
        if (!TOOLS.some(tool => tool.name === name)) {
          return rpcError(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`)
        }
        // 来源：请求头 X-Owlpin-Client，或 endpoint URL 上的 ?client=（WorkBuddy 连接器用后者）
        const client = request.headers.get('x-owlpin-client') ?? new URL(request.url).searchParams.get('client')
        const source = client?.trim().toLowerCase() === 'workbuddy' ? 'workbuddy' : 'api'
        /** @type {ToolResult} */
        let result
        try {
          result =
            name === 'get_report_format'
              ? await getReportFormat(deps, `${new URL(request.url).origin}/__cache/report-format`)
              : await createReport(/** @type {Record<string, unknown>} */ (rawArgs ?? {}), deps, source)
        } catch (error) {
          // 超时、网络错误等：原因只进日志
          console.error(`[report-mcp] tool "${name}" failed`, error)
          result = failure(GENERIC_TOOL_ERROR)
        }
        return rpcResult(id, result)
      }

      case 'tools/list':
        return rpcResult(id, {
          tools: TOOLS.map(tool => {
            const title = toolTitle(tool.name)
            return { ...tool, title, annotations: { title, ...tool.annotations } }
          }),
        })

      default:
        return rpcError(id, ERR_METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  } catch (error) {
    console.error('[report-mcp] handler error', error)
    return rpcError(id, ERR_INTERNAL, 'Internal error')
  }
}

/**
 * EdgeOne 边缘函数入口。环境变量（控制台设置）：PAYLOAD_URL（默认 https://payload.owlpin.cn）、
 * REPORT_RELAY_SECRET（与 payload 的同名 Worker secret 一致，没配时 payload 按 EdgeOne 出口 IP 限流）。
 * @param {{ request: Request & { eo?: { clientIp?: string } }, env?: Record<string, string | undefined> }} context
 */
export async function onRequest(context) {
  const { request, env = {} } = context
  return handleMcpRequest(request, {
    fetch: (input, init) => fetch(input, init),
    payloadUrl: env.PAYLOAD_URL || 'https://payload.owlpin.cn',
    relaySecret: env.REPORT_RELAY_SECRET || '',
    // 只用平台填的 IP，不读客户端可伪造的请求头
    clientIp: request.eo?.clientIp || null,
    openCache: async () => {
      try {
        return await caches.open('owlpin-report-mcp')
      } catch {
        return null
      }
    },
  })
}
