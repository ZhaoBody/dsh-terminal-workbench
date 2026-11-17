#!/usr/bin/env node
/**
 * 本地假 SFTP 服务端：给 RemoteBackend.readStream / writeStream 做真实链路验证。
 * 不依赖 sshd / root：ssh2 的 Server + 最小 SFTP 子集，路径映射到临时目录。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import ssh2 from 'ssh2'
import { ConnectionPool, RemoteBackend } from '../lib/remote-fs.js'
import { registerFsApi } from '../lib/fs-api.js'

const { Server, utils } = ssh2

const { STATUS_CODE: C, OPEN_MODE } = utils.sftp
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sftp-'))
const hostKey = utils.generateKeyPairSync('ed25519').private

function mapPath(p) {
  const norm = path.posix.normalize(String(p || '/'))
  const rel = norm.replace(/^\/+/, '')
  const full = path.join(root, rel)
  if (!full.startsWith(root)) throw new Error('path escape: ' + p)
  return full
}
function attrsOf(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  }
}

let nextHandle = 1
const handles = new Map()

function serveSftp(sftp) {
  const reply = (reqID, fn) => {
    try {
      fn()
    } catch (error) {
      sftp.status(reqID, error?.code === 'ENOENT' ? C.NO_SUCH_FILE : C.FAILURE, String(error?.message ?? error))
    }
  }

  sftp.on('REALPATH', (reqID, p) => reply(reqID, () => {
    const norm = path.posix.normalize(String(p || '/'))
    const abs = norm.startsWith('/') ? norm : '/' + norm
    sftp.name(reqID, [{ filename: abs, longname: abs, attrs: attrsOf(fs.statSync(mapPath(abs))) }])
  }))

  const statHandler = (reqID, p) => reply(reqID, () => {
    const full = mapPath(p)
    sftp.attrs(reqID, attrsOf(fs.statSync(full)))
  })
  sftp.on('STAT', statHandler)
  sftp.on('LSTAT', statHandler)

  sftp.on('OPEN', (reqID, filename, pflags) => reply(reqID, () => {
    const flags = utils.sftp.flagsToString(pflags)
    const fd = fs.openSync(mapPath(filename), flags)
    const id = nextHandle++
    handles.set(id, { kind: 'file', fd })
    sftp.handle(reqID, Buffer.from(String(id)))
  }))

  sftp.on('READ', (reqID, handle, offset, len) => reply(reqID, () => {
    const h = handles.get(Number(handle.toString()))
    if (!h || h.kind !== 'file') throw new Error('bad handle')
    const buf = Buffer.alloc(len)
    const n = fs.readSync(h.fd, buf, 0, len, offset)
    if (n === 0) sftp.status(reqID, C.EOF)
    else sftp.data(reqID, n === len ? buf : buf.subarray(0, n))
  }))

  sftp.on('WRITE', (reqID, handle, offset, data) => reply(reqID, () => {
    const h = handles.get(Number(handle.toString()))
    if (!h || h.kind !== 'file') throw new Error('bad handle')
    fs.writeSync(h.fd, data, 0, data.length, offset)
    sftp.status(reqID, C.OK)
  }))

  sftp.on('CLOSE', (reqID, handle) => reply(reqID, () => {
    const id = Number(handle.toString())
    const h = handles.get(id)
    if (h?.kind === 'file') fs.closeSync(h.fd)
    handles.delete(id)
    sftp.status(reqID, C.OK)
  }))

  sftp.on('OPENDIR', (reqID, p) => reply(reqID, () => {
    const full = mapPath(p)
    const entries = fs.readdirSync(full).map((name) => {
      const st = fs.statSync(path.join(full, name))
      return { filename: name, longname: name, attrs: attrsOf(st) }
    })
    const id = nextHandle++
    handles.set(id, { kind: 'dir', entries, index: 0 })
    sftp.handle(reqID, Buffer.from(String(id)))
  }))

  sftp.on('READDIR', (reqID, handle) => reply(reqID, () => {
    const h = handles.get(Number(handle.toString()))
    if (!h || h.kind !== 'dir') throw new Error('bad dir handle')
    if (h.index >= h.entries.length) {
      sftp.status(reqID, C.EOF)
      return
    }
    const batch = h.entries.slice(h.index, h.index + 100)
    h.index += batch.length
    sftp.name(reqID, batch)
  }))

  sftp.on('REMOVE', (reqID, p) => reply(reqID, () => {
    fs.unlinkSync(mapPath(p))
    sftp.status(reqID, C.OK)
  }))
  sftp.on('RENAME', (reqID, from, to) => reply(reqID, () => {
    fs.renameSync(mapPath(from), mapPath(to))
    sftp.status(reqID, C.OK)
  }))
  sftp.on('MKDIR', (reqID, p) => reply(reqID, () => {
    fs.mkdirSync(mapPath(p))
    sftp.status(reqID, C.OK)
  }))
  sftp.on('RMDIR', (reqID, p) => reply(reqID, () => {
    fs.rmdirSync(mapPath(p))
    sftp.status(reqID, C.OK)
  }))
  sftp.on('SETSTAT', (reqID) => sftp.status(reqID, C.OK))
  sftp.on('FSETSTAT', (reqID) => sftp.status(reqID, C.OK))
  sftp.on('EXTENDED', (reqID) => sftp.status(reqID, C.OP_UNSUPPORTED))
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('sftp', (acceptSftp) => serveSftp(acceptSftp()))
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const remotesFile = path.join(root, 'remotes.json')
fs.writeFileSync(remotesFile, JSON.stringify({
  boxa: { host: '127.0.0.1', port, username: 'u', auth: 'password', password: 'p' },
}))
const pool = new ConnectionPool(remotesFile)
const backend = new RemoteBackend('boxa', pool)

fs.mkdirSync(mapPath('/tmp'), { recursive: true })
fs.writeFileSync(mapPath('/tmp/日志 1.txt'), 'download me 你好')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log('  ✓ ' + name)
  } catch (error) {
    failed += 1
    console.log('  ✗ ' + name + '\n    ' + (error?.stack ?? error))
  }
}

await check('readStream 流式读回远端文件', async () => {
  const { stream, info } = await backend.readStream('/tmp/日志 1.txt')
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.strictEqual(Buffer.concat(chunks).toString('utf8'), 'download me 你好')
  assert.strictEqual(info.type, 'file')
  assert.strictEqual(info.size, Buffer.byteLength('download me 你好'))
})

await check('writeStream 上传新文件并原子发布', async () => {
  const result = await backend.writeStream('/tmp/上传 2.bin', Readable.from([Buffer.from('hello '), Buffer.from('upload')]))
  assert.strictEqual(result.operation, 'create')
  assert.strictEqual(result.size, 12)
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/上传 2.bin'), 'utf8'), 'hello upload')
})

await check('writeStream 默认不覆盖已有文件（FS_EXISTS）', async () => {
  let caught = null
  try {
    await backend.writeStream('/tmp/上传 2.bin', Readable.from([Buffer.from('x')]))
  } catch (error) {
    caught = error
  }
  assert.strictEqual(caught?.code, 'FS_EXISTS')
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/上传 2.bin'), 'utf8'), 'hello upload')
})

await check('writeStream overwrite 覆盖后内容正确', async () => {
  const result = await backend.writeStream('/tmp/上传 2.bin', Readable.from([Buffer.from('new')]), { overwrite: true })
  assert.strictEqual(result.operation, 'update')
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/上传 2.bin'), 'utf8'), 'new')
})

await check('目录不能当文件覆盖（FS_IS_DIRECTORY）', async () => {
  let caught = null
  try {
    await backend.writeStream('/tmp', Readable.from([Buffer.from('x')]), { overwrite: true })
  } catch (error) {
    caught = error
  }
  assert.strictEqual(caught?.code, 'FS_IS_DIRECTORY')
})

await check('上传源流中断：临时文件不残留、目标不被截断', async () => {
  const tmpBefore = fs.readdirSync(mapPath('/tmp')).filter((name) => name.includes('.dsh-twb-'))
  const source = new Readable({
    read() {
      this.destroy(new Error('client aborted'))
    },
  })
  let caught = null
  try {
    await backend.writeStream('/tmp/中断.bin', source, { overwrite: true })
  } catch (error) {
    caught = error
  }
  assert.ok(caught, '源流中断必须抛错')
  /* 清理是 fire-and-forget（不能让 unlink 卡住错误上报），这里等它落地。 */
  const deadline = Date.now() + 1000
  let tmpAfter = fs.readdirSync(mapPath('/tmp')).filter((name) => name.includes('.dsh-twb-'))
  while (tmpAfter.length > tmpBefore.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    tmpAfter = fs.readdirSync(mapPath('/tmp')).filter((name) => name.includes('.dsh-twb-'))
  }
  assert.deepStrictEqual(tmpAfter, tmpBefore, '临时文件必须被清掉')
  assert.strictEqual(fs.existsSync(mapPath('/tmp/中断.bin')), false)
})

/* ---------- 宿主路由层：HTTP 请求 ↔ 真实 SFTP 流 ---------- */
const routes = new Map()
registerFsApi(
  {
    effect(factory) {
      factory()
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
  },
  { remoteFs: { aliases: () => ['boxa'], backendOf: () => backend }, remotesFile },
)
const httpServer = http.createServer((req, res) => {
  const hit = routes.get(new URL(req.url, 'http://x').pathname)
  if (hit === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  hit(req, res)
})
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${httpServer.address().port}/__dsh-terminal-workbench/fs`
const q = (value) => encodeURIComponent(value)

await check('HTTP 下载：流式回传 + RFC 5987 文件名', async () => {
  const response = await fetch(`${base}/download?path=${q('remote:boxa:/tmp/日志 1.txt')}`)
  assert.strictEqual(response.status, 200)
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/)
  assert.strictEqual(await response.text(), 'download me 你好')
})

await check('HTTP 上传：原始二进制直达远端', async () => {
  const response = await fetch(`${base}/upload?path=${q('remote:boxa:/tmp')}&name=${q('http 上传.txt')}`, {
    method: 'POST',
    body: Buffer.from('via http'),
  })
  assert.strictEqual(response.status, 200)
  const json = await response.json()
  assert.strictEqual(json.ok, true)
  assert.strictEqual(json.size, 8)
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/http 上传.txt'), 'utf8'), 'via http')
})

await check('HTTP 上传同名：409 FS_EXISTS，overwrite=1 才覆盖', async () => {
  const target = `${base}/upload?path=${q('remote:boxa:/tmp')}&name=${q('http 上传.txt')}`
  const first = await fetch(target, { method: 'POST', body: Buffer.from('nope') })
  assert.strictEqual(first.status, 409)
  assert.strictEqual((await first.json()).code, 'FS_EXISTS')
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/http 上传.txt'), 'utf8'), 'via http')

  const second = await fetch(target + '&overwrite=1', { method: 'POST', body: Buffer.from('overwritten') })
  assert.strictEqual(second.status, 200)
  assert.strictEqual(fs.readFileSync(mapPath('/tmp/http 上传.txt'), 'utf8'), 'overwritten')
})

await check('HTTP 上传 ../ 文件名：400 且不落盘', async () => {
  const response = await fetch(`${base}/upload?path=${q('remote:boxa:/tmp')}&name=${q('../evil.sh')}`, {
    method: 'POST',
    body: Buffer.from('x'),
  })
  assert.strictEqual(response.status, 400)
  assert.strictEqual((await response.json()).code, 'FS_INVALID_ARGUMENT')
  assert.strictEqual(fs.existsSync(mapPath('/evil.sh')), false)
})

await new Promise((resolve) => httpServer.close(resolve))
pool.dispose()
server.close()
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n== 假 SFTP 真实链路：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
if (failed > 0) process.exitCode = 1
