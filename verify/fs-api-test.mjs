#!/usr/bin/env node
/**
 * 文件面板 HTTP API 契约回归（不需要真实 SSH / 浏览器）。
 *
 * 用假的 webServer + req/res 直接调用路由，校验：
 *   - 路径只走 `remote:别名:/绝对路径`
 *   - 跨机移动被拒、跨机复制走 copyBetween
 *   - 删除必须带 confirm
 *   - 版本守卫与 recursive 参数透传
 *
 * 运行：node verify/fs-api-test.mjs
 */
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { registerFsApi } from '../lib/fs-api.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

function makeRemoteFs() {
  const calls = []
  const backend = {
    async resolve(p) {
      calls.push(['resolve', p])
      return { targetKey: `remote+boxa://${p}`, displayPath: `remote:boxa:${p}` }
    },
    async listDir(p) {
      calls.push(['listDir', p])
      return [{ name: 'a.txt', type: 'file', size: 3 }]
    },
    async stat(p) {
      calls.push(['stat', p])
      return { type: 'file', version: 'v1' }
    },
    async readText(p) {
      calls.push(['readText', p])
      return 'hello'
    },
    async writeText(p, content, expected) {
      calls.push(['writeText', p, content, expected])
      return { version: 'v2' }
    },
    async mkdir(p, opts) {
      calls.push(['mkdir', p, opts])
      return { path: p, created: true }
    },
    async rename(from, to) {
      calls.push(['rename', from, to])
      return { from, to }
    },
    async remove(p, opts) {
      calls.push(['remove', p, opts])
      return { path: p, type: 'file' }
    },
  }
  return {
    calls,
    aliases: () => ['boxa', 'boxb'],
    backendOf(alias) {
      calls.push(['backendOf', alias])
      return backend
    },
    async copyBetween(from, to) {
      calls.push(['copyBetween', from, to])
      return { from, to, type: 'file' }
    },
  }
}

function makeServer(remoteFs) {
  const routes = new Map()
  const disposers = []
  const webCtx = {
    effect(factory) {
      disposers.push(factory())
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
  }
  registerFsApi(webCtx, { remoteFs, remotesFile: '/tmp/remotes.json' })
  return { routes, dispose: () => disposers.forEach((fn) => typeof fn === 'function' && fn()) }
}

/** 调用路由，等 res.end 后返回 { status, body }。 */
function call(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const res = {
      status: 0,
      headers: {},
      chunks: [],
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      end(chunk) {
        if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
        } catch {
          parsed = undefined
        }
        resolve({ status: this.status, body: parsed })
      },
    }
    try {
      handler(req, res)
    } catch (error) {
      reject(error)
      return
    }
    /* readJson 依赖流事件；空体也要 end 一次。 */
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })
}

const PREFIX = '/__dsh-terminal-workbench/fs'

console.log('\nfs-api 路由')

await check('GET /remotes 返回别名', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/remotes`), 'GET', `${PREFIX}/remotes`)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, aliases: ['boxa', 'boxb'] })
})

await check('GET /list 走 resolve + listDir', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/list`), 'GET', `${PREFIX}/list?path=remote:boxa:/srv`)
  assert.equal(result.status, 200)
  assert.equal(result.body.path, '/srv')
  assert.equal(result.body.entries[0].name, 'a.txt')
})

await check('GET /read 返回内容与版本', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/read`), 'GET', `${PREFIX}/read?path=remote:boxa:/srv/a.txt`)
  assert.equal(result.status, 200)
  assert.equal(result.body.content, 'hello')
  assert.equal(result.body.version, 'v1')
})

await check('POST /write 透传版本守卫', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/write`), 'POST', `${PREFIX}/write`, {
    path: 'remote:boxa:/srv/a.txt',
    content: 'new',
    version: 'v1',
  })
  assert.equal(result.status, 200)
  const callArgs = fake.calls.find((item) => item[0] === 'writeText')
  assert.deepEqual(callArgs[3], { kind: 'replaceIfVersion', version: 'v1' })
})

await check('POST /mkdir 固定 recursive=true', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/mkdir`), 'POST', `${PREFIX}/mkdir`, {
    path: 'remote:boxa:/srv/new',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(fake.calls.find((item) => item[0] === 'mkdir'), ['mkdir', '/srv/new', { recursive: true }])
})

await check('POST /move 跨机被拒且不调用 rename', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/move`), 'POST', `${PREFIX}/move`, {
    from: 'remote:boxa:/srv/a',
    to: 'remote:boxb:/srv/b',
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'FS_INVALID_ARGUMENT')
  assert.equal(fake.calls.some((item) => item[0] === 'rename'), false)
})

await check('POST /copy 跨机走 copyBetween', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/copy`), 'POST', `${PREFIX}/copy`, {
    from: 'remote:boxa:/srv/a',
    to: 'remote:boxb:/srv/b',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(
    fake.calls.find((item) => item[0] === 'copyBetween'),
    ['copyBetween', 'remote:boxa:/srv/a', 'remote:boxb:/srv/b'],
  )
})

await check('POST /remove 缺 confirm 被拒且不删除', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/remove`), 'POST', `${PREFIX}/remove`, {
    path: 'remote:boxa:/srv/a',
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'FS_INVALID_ARGUMENT')
  assert.equal(fake.calls.some((item) => item[0] === 'remove'), false)
})

await check('POST /remove 带 confirm 才执行', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/remove`), 'POST', `${PREFIX}/remove`, {
    path: 'remote:boxa:/srv/old',
    recursive: true,
    confirm: true,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(fake.calls.find((item) => item[0] === 'remove'), ['remove', '/srv/old', { recursive: true }])
})

await check('错误方法返回 405', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/list`), 'POST', `${PREFIX}/list`)
  assert.equal(result.status, 405)
  assert.equal(result.body.code, 'METHOD_NOT_ALLOWED')
})

await check('非法路径返回 400', async () => {
  const fake = makeRemoteFs()
  const { routes } = makeServer(fake)
  const result = await call(routes.get(`${PREFIX}/list`), 'GET', `${PREFIX}/list?path=/etc/passwd`)
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'FS_INVALID_ARGUMENT')
})

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[FAIL] ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
