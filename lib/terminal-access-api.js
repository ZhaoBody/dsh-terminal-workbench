/**
 * dsh-terminal-workbench —— 终端访问状态 API（浏览器半侧只读）。
 *
 * 终端写入权限完全跟随 DSH 权限预设，插件不再维护授权表，也没有任何
 * 授予/撤销入口。浏览器标签角标只需要回宿主取一次快照：
 *
 *   GET /__dsh-terminal-workbench/terminal-access?sessionId=…
 *
 * 任何写操作（POST / PUT / DELETE …）一律 405。这样助手即使能通过自己的
 * 专属终端访问本机 HTTP，也没有提权或改权限的通道。
 *
 * @module dsh-terminal-workbench/terminal-access-api
 */

const PREFIX = '/__dsh-terminal-workbench/terminal-access'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sessionIdOf(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 256 ? value.trim() : undefined
}

/**
 * 注册访问状态路由。
 * @param {any} webCtx - 已注入 webServer 的上下文
 * @param {{
 *   controller: { list: (sessionId: string) => any[] },
 *   policyOf: (sessionId: string) => 'ask' | 'never' | undefined,
 *   itemsOf: (sessionId: string, list: any[], policy: 'ask' | 'never' | undefined) => any[],
 * }} options
 */
export function registerTerminalAccessApi(webCtx, options) {
  const { controller, policyOf, itemsOf } = options

  const snapshot = (sessionId) => {
    const list = controller.list(sessionId)
    const policy = policyOf(sessionId)
    return {
      ok: true,
      sessionId,
      policy: policy ?? null,
      terminals: itemsOf(sessionId, list, policy),
    }
  }

  webCtx.effect(
    () =>
      webCtx.webServer.register({
        kind: 'exact',
        path: PREFIX,
        async handler(req, res) {
          try {
            if (req.method !== 'GET' && req.method !== undefined) {
              sendJson(res, 405, {
                ok: false,
                error: '只支持 GET；终端写入权限跟随 DSH 权限预设，本 API 不提供写入',
              })
              return
            }
            const url = new URL(req.url ?? PREFIX, 'http://localhost')
            const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
            if (sessionId === undefined) {
              sendJson(res, 400, { ok: false, error: '缺少有效的 sessionId' })
              return
            }
            sendJson(res, 200, snapshot(sessionId))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'terminal-workbench: terminal access api',
  )
}
