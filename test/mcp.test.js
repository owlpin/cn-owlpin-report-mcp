// @ts-check
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleMcpRequest } from '../edge-functions/mcp.js'

const PAYLOAD = 'https://payload.example.com'

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 内存版 Cache（只实现用到的 match / put） */
function memoryCache() {
  /** @type {Map<string, string>} */
  const store = new Map()
  return /** @type {Cache & { keys: () => string[] }} */ (
    /** @type {unknown} */ ({
      match: async (/** @type {string} */ key) => (store.has(key) ? new Response(store.get(key)) : undefined),
      put: async (/** @type {string} */ key, /** @type {Response} */ response) => {
        store.set(key, await response.text())
      },
      keys: () => [...store.keys()],
    })
  )
}

/** @type {ReturnType<typeof vi.fn>} */
let fetchMock

/** @param {Partial<import('../edge-functions/mcp.js').Deps>} [overrides] */
function deps(overrides = {}) {
  return {
    fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchMock)),
    payloadUrl: PAYLOAD,
    relaySecret: 'relay-secret',
    clientIp: '203.0.113.7',
    openCache: async () => null,
    ...overrides,
  }
}

/** @param {unknown} body @param {Record<string, string>} [headers] @param {string} [url] */
function rpcRequest(body, headers = {}, url = 'https://report.example.com/mcp') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** @param {string} name @param {Record<string, unknown>} [args] */
function callTool(name, args = {}) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

/** @param {Response} response */
async function resultOf(response) {
  return /** @type {{ result: any, error?: any }} */ (await response.json())
}

const FORMAT = { catalogVersion: 1, format: 'COMPONENTS: ...', ttlHours: 8 }
const SPEC = { root: 'page', elements: {} }

beforeEach(() => {
  vi.restoreAllMocks()
  fetchMock = vi.fn()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('protocol', () => {
  it('initializes without credentials and negotiates the version', async () => {
    const response = await handleMcpRequest(
      rpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      deps()
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('www-authenticate')).toBeNull()
    const { result } = await resultOf(response)
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.serverInfo.name).toBe('owlpin-report')
  })

  it('lists both tools with titles, schemas and annotations', async () => {
    const { result } = await resultOf(
      await handleMcpRequest(rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), deps())
    )
    expect(result.tools.map((/** @type {{ name: string }} */ tool) => tool.name)).toEqual([
      'get_report_format',
      'create_report',
    ])
    expect(result.tools[1]).toMatchObject({ title: 'Create report', inputSchema: { required: ['spec'] } })
    expect(result.tools[0].annotations.readOnlyHint).toBe(true)
    expect(result.tools[1].inputSchema.properties.theme.enum).toContain('corporate')
  })

  it('acknowledges notifications with 202, rejects GET and unknown versions', async () => {
    expect(
      (await handleMcpRequest(rpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), deps())).status
    ).toBe(202)
    expect((await handleMcpRequest(new Request('https://report.example.com/mcp'), deps())).status).toBe(405)
    const response = await handleMcpRequest(
      rpcRequest({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' }),
      deps()
    )
    expect(response.status).toBe(400)
  })

  it('opens the cache only for get_report_format', async () => {
    const openCache = vi.fn(async () => null)
    await handleMcpRequest(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }), deps({ openCache }))
    await handleMcpRequest(rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), deps({ openCache }))
    expect(openCache).not.toHaveBeenCalled()
  })

  it('checks the body size in bytes even without Content-Length', async () => {
    const request = new Request('https://report.example.com/mcp', {
      method: 'POST',
      body: new Blob([
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: '汉'.repeat(100_000) } }),
      ]).stream(),
      // @ts-expect-error Node 的 fetch 要求流式 body 声明 duplex
      duplex: 'half',
    })
    expect(request.headers.get('content-length')).toBeNull()
    expect((await handleMcpRequest(request, deps())).status).toBe(413)
  })

  it('rejects browser requests and oversized bodies', async () => {
    const browser = await handleMcpRequest(
      rpcRequest(callTool('create_report', { spec: SPEC }), { Origin: 'https://evil.example' }),
      deps()
    )
    expect(browser.status).toBe(403)
    const large = await handleMcpRequest(
      rpcRequest({ jsonrpc: '2.0', id: 4, method: 'ping' }, { 'Content-Length': String(400 * 1024) }),
      deps()
    )
    expect(large.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers malformed requests with JSON-RPC errors', async () => {
    const bad = new Request('https://report.example.com/mcp', { method: 'POST', body: 'not json' })
    expect((await resultOf(await handleMcpRequest(bad, deps()))).error.code).toBe(-32700)
    expect((await resultOf(await handleMcpRequest(rpcRequest({ id: 1, method: 'ping' }), deps()))).error.code).toBe(
      -32600
    )
    expect((await resultOf(await handleMcpRequest(rpcRequest(callTool('nope')), deps()))).error.code).toBe(-32601)
  })
})

describe('get_report_format', () => {
  it('proxies payload and caches the answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse(FORMAT))
    const cache = memoryCache()
    const first = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('get_report_format')), deps({ openCache: async () => cache }))
    )
    const second = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('get_report_format')), deps({ openCache: async () => cache }))
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${PAYLOAD}/api/reports/format`)
    // 缓存 key 用本服务自己的域名
    expect(cache.keys()).toEqual(['https://report.example.com/__cache/report-format'])
    for (const { result } of [first, second]) {
      expect(result.content[0].text).toBe(FORMAT.format)
      expect(result.structuredContent).toEqual(FORMAT)
    }
  })

  it('fails softly when payload is unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }))
    const { result } = await resultOf(await handleMcpRequest(rpcRequest(callTool('get_report_format')), deps()))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('502')
  })
})

describe('create_report', () => {
  it('forwards the spec with the relay headers and no Origin', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { token: 'tok', url: 'https://app.example.com/b/tok', expiresAt: '2026-10-20T16:00:00.000Z', issues: [] },
        201
      )
    )
    const response = await handleMcpRequest(
      rpcRequest(callTool('create_report', { spec: SPEC }), {}, 'https://report.example.com/mcp?client=workbuddy'),
      deps()
    )
    const { result } = await resultOf(response)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PAYLOAD}/api/reports`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ spec: SPEC })
    expect(init.headers).toMatchObject({
      'X-Owlpin-Client': 'workbuddy',
      'X-Report-Client-Ip': '203.0.113.7',
      'X-Report-Relay-Secret': 'relay-secret',
    })
    expect(Object.keys(init.headers).map(key => key.toLowerCase())).not.toContain('origin')

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.url).toBe('https://app.example.com/b/tok')
    expect(result.content[0].text).toContain('https://app.example.com/b/tok')
  })

  it('passes the optional theme through and omits it when absent', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ token: 't', url: null, expiresAt: 'x', theme: 'nord', issues: [] }, 201)
    )
    const { result } = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC, theme: 'nord' })), deps())
    )
    await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ spec: SPEC, theme: 'nord' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ spec: SPEC })
    expect(result.structuredContent.theme).toBe('nord')
  })

  it('does not send the relay headers without a client IP, a secret or https, and logs it', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ token: 't', url: null, expiresAt: 'x', issues: [] }, 201))
    await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps({ clientIp: null }))
    await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps({ relaySecret: '' }))
    await handleMcpRequest(
      rpcRequest(callTool('create_report', { spec: SPEC })),
      deps({ payloadUrl: 'http://payload.example.com' })
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).not.toHaveProperty('X-Report-Client-Ip')
      expect(init.headers).not.toHaveProperty('X-Report-Relay-Secret')
      expect(init.headers['X-Owlpin-Client']).toBe('api')
    }
    const logged = vi
      .mocked(console.error)
      .mock.calls.filter(([message]) => String(message).includes('relayed client IP'))
    expect(logged).toHaveLength(3)
  })

  it('times out when payload sends headers but stalls the body', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    )
    const pending = handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps())
    await vi.advanceTimersByTimeAsync(15_000)
    const { result } = await resultOf(await pending)
    vi.useRealTimers()
    expect(result.isError).toBe(true)
  })

  it('passes payload validation issues back so the model can retry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'BAD_USER_INPUT',
            message: 'The page needs a Hero with a title',
            details: { issues: ['hero: unknown component Banner'] },
          },
        },
        400
      )
    )
    const { result } = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps())
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('The page needs a Hero with a title')
    expect(result.content[0].text).toContain('hero: unknown component Banner')
    expect(result.content[0].text).toContain('call create_report again')
  })

  it('relays rate limits and hides other upstream failures', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'TOO_MANY_REQUESTS', message: 'Daily report limit reached' } }, 429)
    )
    const limited = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps())
    )
    expect(limited.result.content[0].text).toBe('Daily report limit reached')

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'db down' } }, 500))
    const broken = await resultOf(await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps()))
    expect(broken.result.isError).toBe(true)
    expect(broken.result.content[0].text).not.toContain('db down')

    fetchMock.mockRejectedValueOnce(new Error('aborted'))
    const timedOut = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('create_report', { spec: SPEC })), deps())
    )
    expect(timedOut.result.isError).toBe(true)
  })

  it('validates the spec argument before calling payload', async () => {
    const { result } = await resultOf(
      await handleMcpRequest(rpcRequest(callTool('create_report', { spec: 'text' })), deps())
    )
    expect(result.isError).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
