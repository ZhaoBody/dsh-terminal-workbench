#!/usr/bin/env node
/**
 * SFTP 跟随 SSH 书签的回归。
 *
 * 现场症状：文件面板提示「远端未配置」/ 连不上。根因是面板只认
 * `remotes.json`，而书签里的 host/user/password 在浏览器 localStorage，
 * 宿主根本拿不到。
 *
 * 这里锁住修复后的契约：
 *   1. 书签名可以直接当别名（中文、`+`、空格），只排除 `:` 和 `/`；
 *   2. 浏览器打开面板时把书签连接登记给宿主，宿主只放内存；
 *   3. 登记后 `/remotes` 能看到别名，`/list` 能按该别名解析；
 *   4. client.js 真的把书签连接传给面板。
 *
 * 运行：node verify/sftp-bookmark-test.mjs
 */
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  normalizeRemoteAlias,
  normalizeRemoteEntry,
  ConnectionPool,
  PATH_RE,
} from '../lib/remote-fs.js'
import { registerFsApi } from '../lib/fs-api.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------------ */
/* 别名与连接配置                                                      */
/* ------------------------------------------------------------------ */

test('书签名可以直接当别名：中文、+、空格都放行', () => {
  for (const name of [
    'HY3-295-299+2100-2102',
    'ML4-30-39+海西5-6',
    '测试流程与场景搭建',
    'my box',
  ]) {
    assert.strictEqual(normalizeRemoteAlias(name), name)
  }
})

test('别名拒绝 : / 空串与控制字符', () => {
  for (const bad of ['', '   ', 'a:b', 'a/b', 'a\nb']) {
    assert.throws(() => normalizeRemoteAlias(bad), /别名不合法/)
  }
})

test('remote: 路径语法接受 + 与中文别名', () => {
  const plus = PATH_RE.exec('remote:HY3-295-299+2100-2102:/etc')
  assert.strictEqual(plus?.[1], 'HY3-295-299+2100-2102')
  assert.strictEqual(plus?.[2], '/etc')
  const match = PATH_RE.exec('remote:测试 项目:/srv/app')
  assert.strictEqual(match?.[1], '测试 项目')
  assert.strictEqual(match?.[2], '/srv/app')
  assert.strictEqual(PATH_RE.exec('remote:a:b:/x'), null)
})

test('连接配置默认端口 22，密码认证必须带密码', () => {
  assert.deepStrictEqual(
    normalizeRemoteEntry({ host: '10.0.0.1', username: 'root', auth: 'key', keyPath: '~/.ssh/id_rsa' }),
    { host: '10.0.0.1', port: 22, username: 'root', auth: 'key', password: '', keyPath: '~/.ssh/id_rsa' },
  )
  assert.throws(
    () => normalizeRemoteEntry({ host: '10.0.0.1', username: 'root', auth: 'password' }),
    /缺少 password/,
  )
  assert.throws(() => normalizeRemoteEntry({ host: '', username: 'root' }), /缺少 host/)
  assert.throws(() => normalizeRemoteEntry({ host: 'h', username: '' }), /缺少 username/)
  assert.throws(() => normalizeRemoteEntry({ host: 'h', username: 'u', port: 70000 }), /端口不合法/)
})

test('连接池登记后 aliases/entryOf 立即可见', () => {
  const pool = new ConnectionPool('/nonexistent/remotes.json')
  pool.register('HY3-295-299+2100-2102', {
    host: '10.0.0.1',
    username: 'root',
    auth: 'password',
    password: 'secret',
  })
  assert.deepStrictEqual(pool.aliases(), ['HY3-295-299+2100-2102'])
  assert.strictEqual(pool.entryOf('HY3-295-299+2100-2102')?.host, '10.0.0.1')
  assert.strictEqual(pool.entryOf('不存在'), undefined)
  pool.dispose()
  assert.deepStrictEqual(pool.aliases(), [])
})

test('同名书签重新登记会换掉旧连接配置', () => {
  const pool = new ConnectionPool('/nonexistent/remotes.json')
  pool.register('box', { host: '10.0.0.1', username: 'root', auth: 'key', keyPath: '~/.ssh/a' })
  const first = pool.configKey(pool.entryOf('box'))
  pool.register('box', { host: '10.0.0.2', username: 'root', auth: 'key', keyPath: '~/.ssh/a' })
  const second = pool.configKey(pool.entryOf('box'))
  assert.notStrictEqual(first, second)
  assert.strictEqual(pool.entryOf('box')?.host, '10.0.0.2')
  pool.dispose()
})

/* ------------------------------------------------------------------ */
/* 前端路径解析                                                        */
/* ------------------------------------------------------------------ */

function loadPanel() {
  const src = fs.readFileSync(path.join(root, 'client.fs-panel.js'), 'utf8')
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def } } }
  new Function('window', src)(fakeWindow)
  assert.ok(captured, 'chunk 没有调用 __ModuleLoader__.load')
  return captured.factory(() => ({}))
}

test('面板 parseRemotePath 接受 + 与中文别名', () => {
  const panel = loadPanel()
  assert.deepStrictEqual(panel.parseRemotePath('remote:HY3-295-299+2100-2102:/etc'), {
    alias: 'HY3-295-299+2100-2102',
    path: '/etc',
  })
  assert.deepStrictEqual(panel.parseRemotePath('remote:测试 项目:/srv'), {
    alias: '测试 项目',
    path: '/srv',
  })
  assert.strictEqual(panel.parseRemotePath('remote:a:b:/x'), null)
})

test('面板初始锚点能命中同名书签别名', () => {
  const panel = loadPanel()
  assert.deepStrictEqual(
    panel.initialPathOf(['HY3-295-299+2100-2102'], 'remote:HY3-295-299+2100-2102:/opt'),
    { alias: 'HY3-295-299+2100-2102', path: '/opt' },
  )
})

test('面板 fsApi 暴露 connect', () => {
  const panel = loadPanel()
  assert.strictEqual(typeof panel.fsApi.connect, 'function')
})

/* ------------------------------------------------------------------ */
/* client.js 接线                                                      */
/* ------------------------------------------------------------------ */

function loadClient() {
  const code = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  let definition
  const localStorage = { getItem() { return null }, setItem() {}, removeItem() {} }
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load(value) { definition = value } },
      localStorage,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      setTimeout,
      clearTimeout,
      requestAnimationFrame(fn) { return setTimeout(fn, 0) },
      cancelAnimationFrame(id) { clearTimeout(id) },
    },
    document: {
      createElement() {
        return {
          style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {},
          addEventListener() {}, querySelector() { return null },
        }
      },
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    Node: class Node {},
    CustomEvent: class CustomEvent {},
    TextEncoder,
    btoa(value) { return Buffer.from(String(value), 'binary').toString('base64') },
    ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
    requestAnimationFrame(fn) { return setTimeout(fn, 0) },
    cancelAnimationFrame(id) { clearTimeout(id) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  const requireStub = (name) => {
    if (name === 'react') {
      return {
        lazy(value) { return value }, Suspense() {}, useState() {}, useEffect() {},
        useRef() {}, useCallback() {}, useMemo() {}, useSyncExternalStore() {}, createElement() {},
      }
    }
    if (name === 'react-dom') return { createPortal() {} }
    if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
    if (name === '@deepseek-ai/dsh-client-store') return { defineStore() {} }
    return {}
  }
  return definition.factory(requireStub)
}

test('client.js 的 sshRemoteAlias：优先书名，冲突时退 id / user@host', () => {
  const client = loadClient()
  const alias = client.__twbSsh.sshRemoteAlias
  assert.strictEqual(alias({ name: 'HY3-295-299+2100-2102' }), 'HY3-295-299+2100-2102')
  assert.strictEqual(alias({ name: '测试流程与场景搭建' }), '测试流程与场景搭建')
  assert.strictEqual(alias({ name: 'a:b', id: 'bm-1' }), 'bm-1')
  assert.strictEqual(alias({ name: '', id: '', user: 'root', host: '10.0.0.1' }), 'root@10.0.0.1')
  assert.strictEqual(alias({}), '')
})

test('client.js 把书签连接传给文件面板', () => {
  const code = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.ok(/var fsAlias = ssh === undefined \? '' : sshRemoteAlias\(ssh\.bookmark\)/.test(code))
  assert.ok(/var fsConnection =/.test(code))
  assert.ok(/connection: fsConnection,/.test(code))
  assert.ok(/connection: props\.connection/.test(code))
})

/* ------------------------------------------------------------------ */
/* HTTP 契约：/connect 登记后 /remotes 与 /list 都认                      */
/* ------------------------------------------------------------------ */

function makeRemoteFs() {
  const dynamic = new Map()
  const calls = []
  const backend = {
    async resolve(p) {
      calls.push(['resolve', p])
      return { targetKey: `remote+box://${p}`, displayPath: `remote:box:${p}` }
    },
    async listDir(p) {
      calls.push(['listDir', p])
      return [{ name: 'a.txt', type: 'file', size: 3 }]
    },
  }
  return {
    calls,
    aliases: () => [...dynamic.keys()],
    registerRemote(alias, entry) {
      calls.push(['registerRemote', alias, entry])
      const name = normalizeRemoteAlias(alias)
      dynamic.set(name, normalizeRemoteEntry(entry))
      return name
    },
    backendOf(alias) {
      calls.push(['backendOf', alias])
      return backend
    },
  }
}

function makeServer(remoteFs) {
  const routes = new Map()
  const webCtx = {
    effect(factory) { factory() },
    webServer: {
      register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) },
    },
  }
  registerFsApi(webCtx, { remoteFs, remotesFile: '/tmp/remotes.json' })
  return { routes }
}

function call(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const res = {
      status: 0,
      headers: {},
      chunks: [],
      writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
      end(chunk) {
        if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
        let parsed
        try { parsed = JSON.parse(Buffer.concat(this.chunks).toString('utf8')) } catch { parsed = undefined }
        resolve({ status: this.status, body: parsed })
      },
    }
    try { handler(req, res) } catch (error) { reject(error); return }
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })
}

const PREFIX = '/__dsh-terminal-workbench/fs'

async function asyncTests() {
  await testAsync('POST /connect 登记书签连接，响应不回传密码', async () => {
    const fake = makeRemoteFs()
    const { routes } = makeServer(fake)
    const alias = 'HY3-295-299+2100-2102'
    const result = await call(routes.get(`${PREFIX}/connect`), 'POST', `${PREFIX}/connect`, {
      alias,
      host: '10.0.0.1',
      username: 'root',
      auth: 'password',
      password: 'secret',
    })
    assert.strictEqual(result.status, 200)
    assert.deepStrictEqual(result.body, { ok: true, alias })
    assert.strictEqual(JSON.stringify(result.body).includes('secret'), false, '响应里不能出现密码')
    const registered = fake.calls.find((item) => item[0] === 'registerRemote')
    assert.strictEqual(registered?.[1], alias)
    assert.strictEqual(registered?.[2].password, 'secret')
  })

  await testAsync('登记后 GET /remotes 能看到别名', async () => {
    const fake = makeRemoteFs()
    const { routes } = makeServer(fake)
    const alias = '测试 项目'
    await call(routes.get(`${PREFIX}/connect`), 'POST', `${PREFIX}/connect`, {
      alias,
      host: '10.0.0.1',
      username: 'root',
      auth: 'key',
      keyPath: '~/.ssh/id_rsa',
    })
    const result = await call(routes.get(`${PREFIX}/remotes`), 'GET', `${PREFIX}/remotes`)
    assert.strictEqual(result.status, 200)
    assert.deepStrictEqual(result.body.aliases, [alias])
  })

  await testAsync('登记后 GET /list 能按中文/加号别名解析', async () => {
    const fake = makeRemoteFs()
    const { routes } = makeServer(fake)
    const alias = 'HY3-295-299+2100-2102'
    await call(routes.get(`${PREFIX}/connect`), 'POST', `${PREFIX}/connect`, {
      alias,
      host: '10.0.0.1',
      username: 'root',
      auth: 'key',
      keyPath: '~/.ssh/id_rsa',
    })
    const result = await call(
      routes.get(`${PREFIX}/list`),
      'GET',
      `${PREFIX}/list?path=${encodeURIComponent(`remote:${alias}:/etc`)}`,
    )
    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.body.path, '/etc')
    assert.strictEqual(result.body.entries[0].name, 'a.txt')
    assert.ok(fake.calls.some((item) => item[0] === 'backendOf' && item[1] === alias))
  })

  await testAsync('POST /connect 缺 host 返回 400', async () => {
    const fake = makeRemoteFs()
    const { routes } = makeServer(fake)
    const result = await call(routes.get(`${PREFIX}/connect`), 'POST', `${PREFIX}/connect`, {
      alias: 'box',
      username: 'root',
    })
    assert.strictEqual(result.status, 400)
    assert.strictEqual(result.body.ok, false)
  })
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

await asyncTests()

console.log(`\n== SFTP 书签跟随：${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
