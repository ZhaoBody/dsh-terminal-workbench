#!/usr/bin/env node
/**
 * 文件面板「下载 / 上传」HTTP 契约回归（不需要真实 SSH）。
 *
 * 锁住：
 *   - 下载是流式响应，带 Content-Disposition（中文文件名走 RFC 5987）；
 *   - 上传是原始二进制体，宿主直接 pipe 给 SFTP，不经过 JSON/base64；
 *   - 文件名只允许单段，`../`、`/`、控制字符一律 400；
 *   - 同名文件默认 409 FS_EXISTS，带 overwrite=1 才覆盖。
 *
 * 运行：node verify/fs-transfer-test.mjs
 */
import assert from 'node:assert'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { registerFsApi, safeUploadName } from '../lib/fs-api.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

class FakeRes extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.chunks = []
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers ?? {}
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    return super.end()
  }
  json() {
    try {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
    } catch {
      return undefined
    }
  }
}

function makeRemoteFs(options = {}) {
  const calls = []
  const backend = {
    async resolve(remotePath) {
      calls.push(['resolve', remotePath])
      return { targetKey: `remote+boxa://${remotePath}` }
    },
    async readStream(remotePath) {
      calls.push(['readStream', remotePath])
      if (options.readError) throw options.readError
      const body = Buffer.from(options.downloadBody ?? 'hello world')
      return { stream: Readable.from([body]), info: { size: body.length } }
    },
    async writeStream(remotePath, source, opts) {
      const chunks = []
      for await (const chunk of source) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      calls.push(['writeStream', remotePath, body.toString('utf8'), opts])
      if (options.writeError) throw options.writeError
      return { size: body.length, version: 'v1' }
    },
  }
  return {
    calls,
    aliases: () => ['boxa'],
    backendOf(alias) {
      calls.push(['backendOf', alias])
      return backend
    },
  }
}

function makeServer(remoteFs) {
  const routes = new Map()
  const webCtx = {
    effect(factory) {
      factory()
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
  }
  registerFsApi(webCtx, { remoteFs, remotesFile: '/tmp/remotes.json' })
  return routes
}

async function call(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  const res = new FakeRes()
  const done = finished(res).catch(() => {})
  handler(req, res)
  await done
  return { status: res.status, headers: res.headers, body: res.json(), raw: Buffer.concat(res.chunks) }
}

const PREFIX = '/__dsh-terminal-workbench/fs'
const q = (path) => encodeURIComponent(path)

console.log('\n文件上传 / 下载')

await test('safeUploadName 只放行单段文件名', () => {
  assert.strictEqual(safeUploadName('a.txt'), 'a.txt')
  assert.strictEqual(safeUploadName('中文 日志.log'), '中文 日志.log')
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb']) {
    assert.throws(() => safeUploadName(bad), /不合法|不能包含/)
  }
})

await test('GET /download 流式回传并设置 Content-Disposition', async () => {
  const fake = makeRemoteFs({ downloadBody: 'hello world' })
  const routes = makeServer(fake)
  const result = await call(
    routes.get(`${PREFIX}/download`),
    'GET',
    `${PREFIX}/download?path=${q('remote:boxa:/tmp/日志 1.txt')}`,
  )
  assert.strictEqual(result.status, 200)
  assert.strictEqual(result.raw.toString('utf8'), 'hello world')
  assert.strictEqual(result.headers['content-length'], 11)
  assert.match(result.headers['content-disposition'], /^attachment; filename="/)
  assert.match(result.headers['content-disposition'], /filename\*=UTF-8''/)
  assert.ok(fake.calls.some((item) => item[0] === 'readStream' && item[1] === '/tmp/日志 1.txt'))
})

await test('POST /upload 原始二进制体直达 writeStream', async () => {
  const fake = makeRemoteFs()
  const routes = makeServer(fake)
  const result = await call(
    routes.get(`${PREFIX}/upload`),
    'POST',
    `${PREFIX}/upload?path=${q('remote:boxa:/tmp')}&name=${q('a.txt')}`,
    'hello',
  )
  assert.strictEqual(result.status, 200)
  assert.deepStrictEqual(result.body, { ok: true, path: '/tmp/a.txt', name: 'a.txt', size: 5, version: 'v1' })
  const write = fake.calls.find((item) => item[0] === 'writeStream')
  assert.deepStrictEqual(write, ['writeStream', '/tmp/a.txt', 'hello', { overwrite: false }])
})

await test('overwrite=1 透传给 writeStream', async () => {
  const fake = makeRemoteFs()
  const routes = makeServer(fake)
  await call(
    routes.get(`${PREFIX}/upload`),
    'POST',
    `${PREFIX}/upload?path=${q('remote:boxa:/tmp')}&name=${q('a.txt')}&overwrite=1`,
    'x',
  )
  const write = fake.calls.find((item) => item[0] === 'writeStream')
  assert.deepStrictEqual(write?.[3], { overwrite: true })
})

await test('上传文件名带 ../ 直接 400，不碰远端', async () => {
  const fake = makeRemoteFs()
  const routes = makeServer(fake)
  const result = await call(
    routes.get(`${PREFIX}/upload`),
    'POST',
    `${PREFIX}/upload?path=${q('remote:boxa:/tmp')}&name=${q('../evil.sh')}`,
    'x',
  )
  assert.strictEqual(result.status, 400)
  assert.strictEqual(result.body.code, 'FS_INVALID_ARGUMENT')
  assert.strictEqual(fake.calls.some((item) => item[0] === 'writeStream'), false)
})

await test('同名文件返回 409 FS_EXISTS，前端据此弹覆盖确认', async () => {
  const error = new Error('远端文件已存在：/tmp/a.txt')
  error.code = 'FS_EXISTS'
  const fake = makeRemoteFs({ writeError: error })
  const routes = makeServer(fake)
  const result = await call(
    routes.get(`${PREFIX}/upload`),
    'POST',
    `${PREFIX}/upload?path=${q('remote:boxa:/tmp')}&name=${q('a.txt')}`,
    'x',
  )
  assert.strictEqual(result.status, 409)
  assert.strictEqual(result.body.code, 'FS_EXISTS')
})

console.log(`\n== 文件上传/下载：${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
