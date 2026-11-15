/**
 * dsh-terminal-workbench — 文件面板的宿主侧 HTTP API。
 *
 * 为什么需要这一层：前端拿不到 `ctx.fs`（那是宿主侧服务，浏览器里没有对应的
 * 对象）。面板要列目录、读文件、拖拽复制，只能走 HTTP 回到宿主执行。
 *
 * 安全边界（这几条是硬要求，不能省）：
 * 1. **只在宿主侧拼路径**。前端传的是 `remote:别名:/路径` 这种完整地址，
 *    宿主用 `resolve` 拿 realpath 再操作，避免浏览器侧 `../..` 逃逸。
 * 2. **写操作一律走这里**，前端只发意图。前端直接操作文件系统意味着
 *    任何 XSS 都能读写远端——把权限留在宿主侧是唯一可靠的做法。
 * 3. **删除必须带 confirm 字段**。防的是"前端 bug 误发请求"，
 *    不是防用户（用户那边有二次确认）。
 * 4. 请求体限制大小，避免超大 JSON 打满内存。
 *
 * 路径约定：
 *   GET  /__dsh-terminal-workbench/fs/list?path=remote:boxa:/etc
 *   GET  /__dsh-terminal-workbench/fs/read?path=…
 *   POST /__dsh-terminal-workbench/fs/write   { path, content, version }
 *   POST /__dsh-terminal-workbench/fs/mkdir   { path }
 *   POST /__dsh-terminal-workbench/fs/move    { from, to }
 *   POST /__dsh-terminal-workbench/fs/copy    { from, to }
 *   POST /__dsh-terminal-workbench/fs/remove  { path, recursive, confirm }
 *   GET  /__dsh-terminal-workbench/fs/remotes         已配置的远端别名
 *   POST /__dsh-terminal-workbench/fs/connect         登记书签连接（仅内存）
 *   POST /__dsh-terminal-workbench/fs/disconnect      注销书签连接（仅内存）
 *
 * @module dsh-terminal-workbench/fs-api
 */

/** 请求体上限：写文件的内容也走 JSON，8MB 够用（再大应该走专门的传输通道）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 面板列目录时的条目上限：远端目录可能有几万个文件，全发过去会把浏览器卡死。 */
const MAX_LIST_ENTRIES = 2000

const PREFIX = '/__dsh-terminal-workbench/fs'

/**
 * 读取并解析 JSON 请求体。
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`请求体过大（超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 错误统一成 `{ ok:false, error, code }`：前端只按 code 分支，不解析文字。 */
function sendError(res, error) {
  const code = error?.code ?? 'FS_IO_ERROR'
  /* 4xx 给客户端错误，5xx 给服务端错误——按 code 粗分即可，
     目的是让前端能区分"我传错了"和"远端挂了"。 */
  const status = code === 'FS_INVALID_ARGUMENT' || code === 'FS_NOT_FOUND' || code === 'FS_NOT_REGULAR_FILE' ? 400 : 500
  sendJson(res, status, { ok: false, error: String(error?.message ?? error), code })
}

/** 从 query 里取单值参数（`?path=…`）。 */
function queryOf(url, key) {
  const value = url.searchParams.get(key)
  return value === null ? undefined : value
}

/**
 * 注册全部路由。
 *
 * @param {any} webCtx 含 webServer 的上下文
 * @param {{ remoteFs: { backendOf: Function, copyBetween: Function, aliases: Function }, remotesFile: string }} opts
 */
export function registerFsApi(webCtx, opts) {
  const { remoteFs } = opts

  /**
   * `remote:别名:/路径` → 后端。
   * 不做归一化：`RemoteBackend` 内部已经做了，这里重复做只会让两处逻辑漂移。
   */
  const backendOfRoute = (raw) => {
    const match = /^remote:([^:/]+):(\/.*)$/.exec(String(raw ?? ''))
    if (match === null) {
      const error = new Error(`路径要写成 remote:别名:/绝对/路径，收到：${raw}`)
      error.code = 'FS_INVALID_ARGUMENT'
      throw error
    }
    return { backend: remoteFs.backendOf(match[1]), path: match[2], alias: match[1] }
  }

  /**
   * 取远端 realpath。
   *
   * 注意 `backend.resolve()` 返回的是 FsTarget 对象 `{targetKey, displayPath}`，
   * **不是字符串**——直接拿它去 stat 会得到"文件不存在"。真实路径从 targetKey
   * 里取（`remote+别名:///abs/path`），这也是模块内 pathOf 的同一逻辑。
   */
  const realpathOf = async (backend, path, opts) => {
    const target = await backend.resolve(path, opts)
    const key = String(target?.targetKey ?? '')
    const match = /^remote\+[^:/]+:\/\/(.*)$/.exec(key)
    return match === null ? path : match[1]
  }

  const route = (method, path, handler) =>
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path,
          handler(req, res) {
            if (req.method !== method) {
              sendJson(res, 405, { ok: false, error: `只支持 ${method}`, code: 'METHOD_NOT_ALLOWED' })
              return
            }
            Promise.resolve(handler(req, res)).catch((error) => sendError(res, error))
          },
        }),
      `terminal-workbench: fs api ${method} ${path}`,
    )

  /* ---------- 远端清单：面板的连接选择器用它 ---------- */
  route('GET', `${PREFIX}/remotes`, async (_req, res) => {
    sendJson(res, 200, { ok: true, aliases: remoteFs.aliases() })
  })

  /* ---------- 登记当前 SSH 书签的连接 ----------
     文件面板不再强制用户手写 remotes.json：打开面板时把书签的
     host/port/username/auth/password 交给宿主，宿主只放内存。
     密码只在请求体里出现，不写日志、不落盘。 */
  route('POST', `${PREFIX}/connect`, async (req, res) => {
    const body = await readJson(req)
    if (typeof remoteFs.registerRemote !== 'function') {
      const error = new Error('当前版本不支持从书签登记远端连接')
      error.code = 'FS_IO_ERROR'
      throw error
    }
    const alias = remoteFs.registerRemote(body?.alias, body)
    sendJson(res, 200, { ok: true, alias })
  })

  /* ---------- 注销动态登记 ----------
     只删宿主内存里的书签连接，不碰 remotes.json。测试注入的别名、或面板
     切走后的临时连接用它收尾，避免动态表越积越多、串到别的窗口。 */
  route('POST', `${PREFIX}/disconnect`, async (req, res) => {
    const body = await readJson(req)
    if (typeof remoteFs.unregisterRemote !== 'function') {
      const error = new Error('当前版本不支持注销远端连接')
      error.code = 'FS_IO_ERROR'
      throw error
    }
    const alias = String(body?.alias ?? '')
    const removed = remoteFs.unregisterRemote(alias)
    sendJson(res, 200, { ok: true, alias, removed: removed === true })
  })

  /* ---------- 列目录 ---------- */
  route('GET', `${PREFIX}/list`, async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const raw = queryOf(url, 'path')
    const { backend, path } = backendOfRoute(raw)
    const resolved = await realpathOf(backend, path, {})
    const entries = await backend.listDir(resolved)
    /* 截断而不是报错：用户仍能看到前 2000 个，比"目录太大不给看"有用。 */
    const truncated = entries.length > MAX_LIST_ENTRIES
    const visible = truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries
    sendJson(res, 200, {
      ok: true,
      path: resolved,
      count: entries.length,
      truncated,
      entries: visible.map((entry) => ({
        name: entry.name,
        type: entry.type,
        size: entry.size,
        /* 前端只需要相对名和类型；完整路径由它自己拼，
           避免把宿主内部的 targetKey 格式泄漏到前端。 */
      })),
    })
  })

  /* ---------- 读文件 ---------- */
  route('GET', `${PREFIX}/read`, async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const raw = queryOf(url, 'path')
    const { backend, path } = backendOfRoute(raw)
    const resolved = await realpathOf(backend, path, {})
    const info = await backend.stat(resolved)
    if (info === undefined) {
      const error = new Error(`远端文件不存在：${raw}`)
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    if (info.type !== 'file') {
      const error = new Error(`不是普通文件：${raw}`)
      error.code = 'FS_NOT_REGULAR_FILE'
      throw error
    }
    const content = await backend.readText(resolved)
    sendJson(res, 200, { ok: true, path: resolved, content, version: info.version })
  })

  /* ---------- 写文件 ---------- */
  route('POST', `${PREFIX}/write`, async (req, res) => {
    const body = await readJson(req)
    const { backend, path } = backendOfRoute(body?.path)
    const resolved = await realpathOf(backend, path, {})
    const content = String(body?.content ?? '')
    /* 带版本守卫：面板打开后文件被别人改过，直接覆盖会静默丢改动。
       version 为空时按"无条件写"处理（新建文件场景）。 */
    const expected =
      typeof body?.version === 'string' && body.version !== '' ? { kind: 'replaceIfVersion', version: body.version } : undefined
    const outcome = await backend.writeText(resolved, content, expected)
    sendJson(res, 200, { ok: true, path: resolved, version: outcome?.version })
  })

  /* ---------- 建目录 ---------- */
  route('POST', `${PREFIX}/mkdir`, async (req, res) => {
    const body = await readJson(req)
    const { backend, path } = backendOfRoute(body?.path)
    const resolved = await realpathOf(backend, path, {})
    await backend.mkdir(resolved, { recursive: true })
    sendJson(res, 200, { ok: true, path: resolved })
  })

  /* ---------- 移动 / 改名 ---------- */
  route('POST', `${PREFIX}/move`, async (req, res) => {
    const body = await readJson(req)
    const from = backendOfRoute(body?.from)
    const to = backendOfRoute(body?.to)
    if (from.alias !== to.alias) {
      const error = new Error('跨远端不能移动，请改用复制（再删除源）')
      error.code = 'FS_INVALID_ARGUMENT'
      throw error
    }
    const fromPath = await realpathOf(from.backend, from.path, {})
    const toPath = await realpathOf(to.backend, to.path)
    await from.backend.rename(fromPath, toPath)
    sendJson(res, 200, { ok: true, from: fromPath, to: toPath })
  })

  /* ---------- 复制（含跨机直传） ---------- */
  route('POST', `${PREFIX}/copy`, async (req, res) => {
    const body = await readJson(req)
    const fromRaw = String(body?.from ?? '')
    const toRaw = String(body?.to ?? '')
    backendOfRoute(fromRaw) // 仅用于校验写法
    backendOfRoute(toRaw)
    await remoteFs.copyBetween(fromRaw, toRaw)
    sendJson(res, 200, { ok: true, from: fromRaw, to: toRaw })
  })

  /* ---------- 删除 ---------- */
  route('POST', `${PREFIX}/remove`, async (req, res) => {
    const body = await readJson(req)
    /* confirm 不是防用户的（用户那边有二次确认），是防"前端 bug 误发请求"。
       少了它，一个循环里拼错参数就能把目录删光。 */
    if (body?.confirm !== true) {
      const error = new Error('删除必须在请求体里带 confirm: true')
      error.code = 'FS_INVALID_ARGUMENT'
      throw error
    }
    const { backend, path } = backendOfRoute(body?.path)
    const resolved = await realpathOf(backend, path, {})
    await backend.remove(resolved, { recursive: body?.recursive === true })
    sendJson(res, 200, { ok: true, path: resolved })
  })

  console.log(`[terminal-workbench] 文件面板 API 已注册（前缀 ${PREFIX}）`)
}
