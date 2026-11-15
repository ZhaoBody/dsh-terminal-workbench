/**
 * 文件面板（前端抽屉）测试。
 *
 * 分两层：
 *   [1] 纯函数 —— 路径拼接、父子关系、大小格式化、可编辑判定。
 *       这些错了的表现是"面板点进去目录越走越歪"或"删错东西"，必须逐条验。
 *   [2] HTTP 契约 —— 用真 server 起 fs-api，再用面板自己的 fsApi 客户端打通，
 *       确认前端发出的请求形状和宿主期望的一致（含删除的 confirm 必须由客户端补）。
 *
 * client.fs-panel.js 是 __ModuleLoader__ 包装的 chunk，用假 window 捕获 factory
 * 后按 (require) 求值即可拿到导出——与浏览器里的加载方式一致。
 */
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')

const PANEL = path.join(__dirname, '..', 'client.fs-panel.js')
const FS_API = path.join(__dirname, '..', 'lib', 'fs-api.js')
const FS_LIB = path.join(__dirname, '..', 'lib', 'remote-fs.js')

/** HTTP 契约段需要本机 127.0.0.1:2222 上有一台测试 sshd；没有就跳过。 */
const RUN_E2E = process.env.TWB_E2E === '1'

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 按浏览器的方式加载 chunk：拿到 window.__ModuleLoader__.load 的 def，再跑 factory。 */
function loadPanel() {
  const src = fs.readFileSync(PANEL, 'utf8')
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def } } }
  // eslint-disable-next-line no-new-func
  new Function('window', src)(fakeWindow)
  if (captured === null) throw new Error('chunk 没有调用 __ModuleLoader__.load')
  assert.strictEqual(captured.id, 'dsh-terminal-workbench')
  assert.strictEqual(captured.chunk, 'client.fs-panel.js')
  return captured.factory(() => ({}))
}

function request(port, method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathName,
        headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: 15000,
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = { raw: text }
          }
          resolve({ status: res.statusCode, body: json })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function main() {
  const panel = loadPanel()

  console.log('\n[0] chunk 装载契约')
  await test('chunk 文件名符合宿主的 client.<name>.js 规则', () => {
    /* 宿主 dsh-client-modules 只接受 ^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$。
       文件名不合规时 require.async 直接抛 "invalid relative chunk request"，
       面板打不开还会把整个 slot 渲染树打崩（现场表现为一片空白）。 */
    const rule = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
    assert.ok(rule.test(path.basename(PANEL)), `chunk 文件名不合规：${path.basename(PANEL)}`)
    assert.ok(fs.existsSync(PANEL), `chunk 文件不存在：${PANEL}`)
  })
  await test('client.js 用同名相对路径按需加载', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')
    assert.ok(
      src.includes(`require.async('./${path.basename(PANEL)}')`),
      `client.js 没有按需加载 ./${path.basename(PANEL)}`,
    )
  })
  await test('面板打开后按钮让到面板外侧，不遮面板头部', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')
    /* 面板宽度和按钮偏移必须用同一个表达式；只改一处会让按钮重新压到面板上。 */
    assert.ok(
      src.includes('.tp-fs{position:absolute;right:0;top:0;bottom:0;z-index:39;width:min(380px,72%)'),
      '面板宽度表达式变了：同步修改 .tp-fs-toggle[data-open=true] 的 right 偏移',
    )
    assert.ok(
      src.includes('.tp-fs-toggle[data-open=true]{right:calc(min(380px,72%) + 2px)'),
      '打开态按钮没有让到面板左外侧',
    )
    assert.ok(
      src.includes('.tp-fs-head{display:flex;align-items:center;gap:4px;padding:8px 8px 6px 8px'),
      '面板头部还留着给悬浮按钮让位的顶部内边距',
    )
  })

  console.log('\n[1] 路径纯函数')
  await test('parseRemotePath 拆出别名与路径', () => {
    assert.deepStrictEqual(panel.parseRemotePath('remote:boxa:/etc/nginx'), { alias: 'boxa', path: '/etc/nginx' })
  })
  await test('parseRemotePath 接受含点/下划线/短横的别名', () => {
    assert.deepStrictEqual(panel.parseRemotePath('remote:prod-db_1.local:/var'), { alias: 'prod-db_1.local', path: '/var' })
  })
  await test('parseRemotePath 拒绝缺路径或非远端写法', () => {
    assert.strictEqual(panel.parseRemotePath('remote:boxa:'), null)
    assert.strictEqual(panel.parseRemotePath('boxa:/etc'), null)
    assert.strictEqual(panel.parseRemotePath('/etc/passwd'), null)
    assert.strictEqual(panel.parseRemotePath(''), null)
    assert.strictEqual(panel.parseRemotePath(undefined), null)
  })
  await test('makeRemotePath 与 parseRemotePath 互逆', () => {
    const text = panel.makeRemotePath('boxa', '/etc/nginx')
    assert.strictEqual(text, 'remote:boxa:/etc/nginx')
    assert.deepStrictEqual(panel.parseRemotePath(text), { alias: 'boxa', path: '/etc/nginx' })
  })
  await test('makeRemotePath 补前导斜杠、空路径归到根', () => {
    assert.strictEqual(panel.makeRemotePath('boxa', 'etc'), 'remote:boxa:/etc')
    assert.strictEqual(panel.makeRemotePath('boxa', ''), 'remote:boxa:/')
    assert.strictEqual(panel.makeRemotePath('', '/etc'), '')
  })
  await test('joinRemotePath 不在根上产生双斜杠', () => {
    assert.strictEqual(panel.joinRemotePath('/', 'tmp'), '/tmp')
    assert.strictEqual(panel.joinRemotePath('/a', 'b'), '/a/b')
    assert.strictEqual(panel.joinRemotePath('/a/', 'b'), '/a/b')
  })
  await test('parentOf 到根为止，不返回空串', () => {
    assert.strictEqual(panel.parentOf('/a/b/c'), '/a/b')
    assert.strictEqual(panel.parentOf('/a'), '/')
    assert.strictEqual(panel.parentOf('/'), '/')
    assert.strictEqual(panel.parentOf(''), '/')
    assert.strictEqual(panel.parentOf('/a/'), '/')
  })
  await test('baseNameOf 取最后一段', () => {
    assert.strictEqual(panel.baseNameOf('/a/b/c.txt'), 'c.txt')
    assert.strictEqual(panel.baseNameOf('/a/'), 'a')
    assert.strictEqual(panel.baseNameOf('/'), '/')
  })
  await test('一路下钻再回退能回到原点', () => {
    let dir = '/'
    for (const name of ['home', 'deploy', 'app']) dir = panel.joinRemotePath(dir, name)
    assert.strictEqual(dir, '/home/deploy/app')
    dir = panel.parentOf(dir)
    assert.strictEqual(dir, '/home/deploy')
    /* 再退两级就到根了：parentOf('/home/deploy') = '/home'，再退 = '/' */
    assert.strictEqual(panel.parentOf(panel.parentOf(dir)), '/')
    /* 从根再拼一次，不会出现 '//x' */
    assert.strictEqual(panel.joinRemotePath(panel.parentOf(panel.parentOf(dir)), 'x'), '/x')
  })

  console.log('\n[2] 显示与可编辑判定')
  await test('formatSize 用 1024 进制', () => {
    assert.strictEqual(panel.formatSize(0), '0 B')
    assert.strictEqual(panel.formatSize(512), '512 B')
    assert.strictEqual(panel.formatSize(1024), '1.0 KB')
    assert.strictEqual(panel.formatSize(1536), '1.5 KB')
    assert.strictEqual(panel.formatSize(1024 * 1024), '1.0 MB')
    assert.strictEqual(panel.formatSize(10 * 1024 * 1024), '10 MB')
    assert.strictEqual(panel.formatSize(undefined), '')
    assert.strictEqual(panel.formatSize(-1), '')
  })
  await test('canEditFile 拒绝目录与超大文件', () => {
    assert.strictEqual(panel.canEditFile({ type: 'file', size: 10 }), true)
    assert.strictEqual(panel.canEditFile({ type: 'file', size: panel.MAX_EDIT_BYTES + 1 }), false)
    assert.strictEqual(panel.canEditFile({ type: 'directory', size: undefined }), false)
    assert.strictEqual(panel.canEditFile(null), false)
  })
  await test('MAX_EDIT_BYTES 小于宿主 8MB 上限', () => {
    /* 前端上限必须比宿主小：内容要过 JSON 转义，转义后会膨胀，
       若前端卡在 8MB，正好 8MB 的文件会因膨胀后被宿主拒绝。 */
    assert.ok(panel.MAX_EDIT_BYTES < 8 * 1024 * 1024, '前端上限应小于宿主 8MB')
  })
  await test('iconOf 按类型与扩展名区分', () => {
    assert.strictEqual(panel.iconOf({ type: 'directory', name: 'src' }), '▸')
    assert.strictEqual(panel.iconOf({ type: 'file', name: 'a.png' }), '▣')
    assert.strictEqual(panel.iconOf({ type: 'file', name: 'a.tar.gz' }), '▤')
    assert.strictEqual(panel.iconOf({ type: 'file', name: 'a.js' }), '⌗')
    assert.strictEqual(panel.iconOf({ type: 'file', name: 'a.yaml' }), '⚙')
    assert.strictEqual(panel.iconOf({ type: 'file', name: 'a.md' }), '≡')
    assert.strictEqual(panel.iconOf(null), '·')
  })
  await test('删除始终要求确认', () => {
    assert.strictEqual(panel.needsConfirmBeforeRemove(), true)
  })
  await test('initialPathOf 优先用会话 cwd；书签别名未登记时不回落到别的机器', () => {
    assert.deepStrictEqual(panel.initialPathOf(['boxa', 'boxb'], 'remote:boxb:/srv'), { alias: 'boxb', path: '/srv' })
    /* 关键回归：当前书签没登记成功时返回 missing，绝不能拿 boxa 顶替。
       现场症状是"书签是 A 车，面板却连到 B 车（甚至 127.0.0.1）"。 */
    assert.deepStrictEqual(panel.initialPathOf(['boxa', 'boxb'], 'remote:gone:/srv'), { alias: '', path: '/', missing: 'gone' })
    assert.deepStrictEqual(panel.initialPathOf(['boxa'], ''), { alias: 'boxa', path: '/' })
    assert.deepStrictEqual(panel.initialPathOf([], 'remote:boxa:/srv'), { alias: '', path: '/', missing: 'boxa' })
    assert.deepStrictEqual(panel.initialPathOf([], ''), { alias: '', path: '/' })
  })
  await test('fsApi 暴露 connect / disconnect', () => {
    assert.strictEqual(typeof panel.fsApi.connect, 'function')
    assert.strictEqual(typeof panel.fsApi.disconnect, 'function')
  })

  if (!RUN_E2E) {
    console.log('\n[3] HTTP 契约：跳过（需要 127.0.0.1:2222 上的测试 sshd；设置 TWB_E2E=1 启用）')
    console.log(`\n通过 ${passed} / ${passed + failed}`)
    if (failed > 0) process.exitCode = 1
    return
  }

  console.log('\n[3] HTTP 契约：面板客户端 ↔ 宿主路由')
  const { registerFsApi } = await import(FS_API)
  const { ConnectionPool, RemoteBackend } = await import(FS_LIB)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twb-panel-'))
  const remotesFile = path.join(dir, 'remotes.json')
  const base = {
    host: process.env.TWB_E2E_HOST ?? '127.0.0.1',
    port: Number(process.env.TWB_E2E_PORT ?? 2222),
    username: process.env.TWB_E2E_USER ?? 'root',
    auth: 'key',
    keyPath: process.env.TWB_E2E_KEY ?? path.join(os.homedir(), '.ssh', 'twb_test_key'),
  }
  fs.writeFileSync(remotesFile, JSON.stringify({ boxa: base }))
  const pool = new ConnectionPool(remotesFile)
  const backends = new Map()
  const backendOf = (alias) => {
    if (!backends.has(alias)) backends.set(alias, new RemoteBackend(alias, pool))
    return backends.get(alias)
  }
  const remoteFs = {
    backendOf,
    aliases: () => ['boxa'],
    copyBetween: async (fromRaw, toRaw) => {
      const f = /^remote:([\w.-]+):(\/.*)$/.exec(fromRaw)
      const t = /^remote:([\w.-]+):(\/.*)$/.exec(toRaw)
      if (f[1] === t[1]) return backendOf(f[1]).copy(f[2], t[2])
      return backendOf(f[1]).copyTo(backendOf(t[1]), f[2], t[2])
    },
  }
  const routes = []
  const webCtx = {
    effect(fn) {
      return fn()
    },
    webServer: {
      register(def) {
        routes.push(def)
        return () => {}
      },
    },
  }
  registerFsApi(webCtx, { remoteFs, remotesFile })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const hit = routes.find((r) => r.path === url.pathname)
    if (hit === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    hit.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  /* 把面板的 fsApi 指向测试 server：它内部是相对 URL（浏览器里同源），
     在 Node 里没有 base，所以临时包一层拼绝对地址。 */
  const origFetch = global.fetch
  global.fetch = (url, init) => origFetch(`http://127.0.0.1:${port}${url}`, init)
  const api = panel.fsApi

  const root = `/tmp/twb-panel-${Date.now().toString(36)}`
  await backendOf('boxa').mkdir(`${root}/sub`, { recursive: true })
  await backendOf('boxa').writeText(`${root}/note.txt`, 'hello panel')

  await test('remotes 返回别名', async () => {
    const json = await api.remotes()
    assert.deepStrictEqual(json.aliases, ['boxa'])
  })
  await test('list 返回条目名/类型/大小', async () => {
    const json = await api.list(panel.makeRemotePath('boxa', root))
    assert.strictEqual(json.path, root)
    const names = json.entries.map((e) => e.name).sort()
    assert.deepStrictEqual(names, ['note.txt', 'sub'])
    const note = json.entries.find((e) => e.name === 'note.txt')
    assert.strictEqual(note.type, 'file')
    assert.strictEqual(note.size, 11)
    assert.strictEqual(json.entries.find((e) => e.name === 'sub').type, 'directory')
  })
  await test('read 返回内容供编辑器载入', async () => {
    const json = await api.read(panel.makeRemotePath('boxa', `${root}/note.txt`))
    assert.strictEqual(json.content, 'hello panel')
    assert.strictEqual(typeof json.version, 'string')
  })
  await test('write 带版本守卫：版本对得上才写成功', async () => {
    const target = panel.makeRemotePath('boxa', `${root}/note.txt`)
    const first = await api.read(target)
    const out = await api.write(target, 'changed', first.version)
    assert.strictEqual(out.ok, true)
    const second = await api.read(target)
    assert.strictEqual(second.content, 'changed')
    assert.notStrictEqual(second.version, first.version)
  })
  await test('write 版本过期被拒（终端里改过文件后不能再覆盖）', async () => {
    const target = panel.makeRemotePath('boxa', `${root}/note.txt`)
    const stale = await api.read(target)
    /* 模拟终端里 vim 保存了一次 */
    await backendOf('boxa').writeText(`${root}/note.txt`, 'edited in vim')
    let caught = null
    try {
      await api.write(target, 'from panel', stale.version)
    } catch (error) {
      caught = error
    }
    assert.notStrictEqual(caught, null, '版本过期必须报错')
    assert.strictEqual(await backendOf('boxa').readText(`${root}/note.txt`), 'edited in vim')
  })
  await test('mkdir 建目录后能列出来', async () => {
    await api.mkdir(panel.makeRemotePath('boxa', `${root}/made`))
    const json = await api.list(panel.makeRemotePath('boxa', root))
    assert.ok(json.entries.some((e) => e.name === 'made' && e.type === 'directory'))
  })
  await test('move 改名后旧名消失新名出现', async () => {
    await api.mkdir(panel.makeRemotePath('boxa', `${root}/a.txt`))
    await api.move(panel.makeRemotePath('boxa', `${root}/a.txt`), panel.makeRemotePath('boxa', `${root}/b.txt`))
    const json = await api.list(panel.makeRemotePath('boxa', root))
    const names = json.entries.map((e) => e.name)
    assert.ok(names.includes('b.txt'))
    assert.ok(!names.includes('a.txt'))
  })
  await test('copy 复制文件内容一致', async () => {
    await backendOf('boxa').writeText(`${root}/src.txt`, 'copy me')
    await api.copy(panel.makeRemotePath('boxa', `${root}/src.txt`), panel.makeRemotePath('boxa', `${root}/dst.txt`))
    assert.strictEqual(await backendOf('boxa').readText(`${root}/dst.txt`), 'copy me')
  })
  await test('remove 由客户端自动补 confirm', async () => {
    await api.mkdir(panel.makeRemotePath('boxa', `${root}/killme`))
    /* 关键：api.remove 的签名只有 (path, recursive)，confirm 是内部补的。
       这条测试保证"前端不必记得传 confirm"，也就不会因为漏传而永远删不掉。 */
    await api.remove(panel.makeRemotePath('boxa', `${root}/killme`), false)
    const json = await api.list(panel.makeRemotePath('boxa', root))
    assert.ok(!json.entries.some((e) => e.name === 'killme'))
  })
  await test('错误统一抛成带 code 的 Error', async () => {
    let caught = null
    try {
      await api.list(panel.makeRemotePath('boxa', `${root}/does-not-exist`))
    } catch (error) {
      caught = error
    }
    assert.notStrictEqual(caught, null)
    assert.ok(/FS_(NOT_FOUND|IO_ERROR)/.test(caught.message), `错误信息应带 code，实际：${caught.message}`)
  })
  await test('非 remote: 前缀被宿主拒绝', async () => {
    let caught = null
    try {
      await api.list('/etc/passwd')
    } catch (error) {
      caught = error
    }
    assert.notStrictEqual(caught, null)
    assert.ok(/FS_INVALID_ARGUMENT/.test(caught.message))
  })

  global.fetch = origFetch
  await backendOf('boxa').remove(root, { recursive: true }).catch(() => {})
  server.close()
  pool.dispose()

  console.log(`\n通过 ${passed} / ${passed + failed}`)
  if (failed > 0) {
    console.log('失败项：')
    for (const item of failures) console.log(`  - ${item.name}: ${item.error?.message ?? item.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
