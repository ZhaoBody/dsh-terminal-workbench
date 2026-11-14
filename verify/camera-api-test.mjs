#!/usr/bin/env node
/**
 * 相机取流代理回归（本地假相机，不碰真机）。
 *
 * 覆盖宿主侧 `/camera/*` 的契约：
 *   - 会话建立：参数校验、随机 id、口令不进 URL；
 *   - Digest 认证：首次 401 挑战后重试成功，后续请求复用认证（不再挑战）；
 *   - Basic 认证兜底；
 *   - MJPEG 直转、快照轮询包装、单张快照；
 *   - 错误路径：未知会话 404、错误方法 405、错误口令 400、关闭会话后 404。
 *
 * 假相机自己算 Digest（不复用生产代码的 digestAuthorization），
 * 避免同一个 bug 在两边互相抵消。
 *
 * 运行：node verify/camera-api-test.mjs
 */
import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { registerCameraApi, __test } from '../lib/camera-api.js'

const USER = 'root'
const PASSWORD = 'test-pass'
const REALM = 'mock-camera'

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex')

/** 一张最小的“JPEG”：魔数 + 填充，代理只看 content-type 和字节。 */
function fakeJpeg(size) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size, 0x41), Buffer.from([0xff, 0xd9])])
}

const JPEG = fakeJpeg(64)

function parseAuth(header) {
  const params = Object.create(null)
  const text = String(header ?? '')
  const start = text.toLowerCase().indexOf('digest ')
  if (start === -1) return null
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g
  let match
  while ((match = re.exec(text.slice(start + 7))) !== null) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]
  }
  return params
}

/** 独立实现 Digest 校验。 */
function digestOk(req, header, uri) {
  const params = parseAuth(header)
  if (params === null) return false
  const ha1 = md5(`${USER}:${REALM}:${PASSWORD}`)
  const ha2 = md5(`${req.method}:${uri}`)
  const expected = params.qop
    ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`)
  return params.username === USER && params.response === expected
}

let digestChallenges = 0

function requireDigest(req, res, uri) {
  if (digestOk(req, req.headers.authorization, uri)) return true
  digestChallenges += 1
  res.writeHead(401, {
    'www-authenticate': `Digest realm="${REALM}", nonce="mock-nonce-1", algorithm=PROJ, qop="auth"`,
  })
  res.end('unauthorized')
  return false
}

const cameraServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://camera')
  const uri = `${url.pathname}${url.search}`

  if (url.pathname === '/basic') {
    const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'www-authenticate': `Basic realm="${REALM}"` })
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPEG.length })
    res.end(JPEG)
    return
  }

  if (url.pathname === '/mjpeg' || url.pathname === '/snapshot') {
    if (!requireDigest(req, res, uri)) return
    if (url.pathname === '/snapshot') {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPEG.length })
      res.end(JPEG)
      return
    }
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=mockframe' })
    for (let index = 0; index < 2; index += 1) {
      res.write('--mockframe\r\n')
      res.write('Content-Type: image/jpeg\r\n')
      res.write(`Content-Length: ${JPEG.length}\r\n\r\n`)
      res.write(JPEG)
      res.write('\r\n')
    }
    res.end()
    return
  }

  res.writeHead(404)
  res.end('not found')
})

/* ---------- 假 RTSP 服务器：DESCRIBE + Digest + SDP，支持同连接多次请求 ---------- */

const RTSP_REALM = 'iPOLiS'
const RTSP_NONCE = 'mock-rtsp-nonce'
const RTSP_CODECS = new Map([
  ['/profile1/media.smp', 'H265'],
  ['/profile2/media.smp', 'H264'],
  ['/profile3/media.smp', 'H265'],
  ['/profile4/media.smp', 'H265'],
  ['/profile5/media.smp', 'H264'],
  ['/profile6/media.smp', 'H265'],
  ['/axis-media/media.amp?videocodec=h264', 'H264'],
  ['/axis-media/media.amp', 'H265'],
  ['/Streaming/Channels/101', 'H265'],
  ['/Streaming/Channels/102', 'H264'],
  ['/cam/realmonitor?channel=1&subtype=0', 'H265'],
  ['/cam/realmonitor?channel=1&subtype=1', 'H264'],
])

/* 记录每个连接上的请求，测试用来确认挑战和认证没有换连接。 */
const rtspProbeLog = []
let rtspConnectionSeq = 0
/* 模拟两类相机：nonce 是否绑定连接、401 后是否主动断开。 */
let rtspBindNonce = true
let rtspCloseAfterChallenge = false

function rtspDigestOk(method, uri, path, header, nonce) {
  const params = parseAuth(header)
  if (params === null) return false
  const ha1 = md5(`${USER}:${RTSP_REALM}:${PASSWORD}`)
  return [uri, path].some((target) => {
    const ha2 = md5(`${method}:${target}`)
    const expected = params.qop
      ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
      : md5(`${ha1}:${params.nonce}:${ha2}`)
    return (
      params.username === USER &&
      params.nonce === nonce &&
      params.response === expected
    )
  })
}

function rtspSdp(codec) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Mock Camera',
    'c=IN IP4 0.0.0.0',
    't=0 0',
    'm=video 0 RTP/AVP 96',
    `a=rtpmap:96 ${codec}/90000`,
    'a=control:trackID=1',
    'm=application 0 RTP/AVP 107',
    'a=rtpmap:107 vnd.onvif.metadata/90000',
    'a=control:trackID=2',
    '',
  ].join('\r\n')
}

const rtspServer = net.createServer((socket) => {
  const connectionId = ++rtspConnectionSeq
  let buffer = ''
  let lastCseq = 0
  let nonce = rtspBindNonce ? '' : RTSP_NONCE

  const write401 = (cseq) => {
    socket.write(
      `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\n` +
        `WWW-Authenticate: Digest realm="${RTSP_REALM}", nonce="${nonce}", qop="auth"\r\n\r\n`,
    )
    if (rtspCloseAfterChallenge) socket.end()
  }

  const handle = (head) => {
    const match = /^DESCRIBE\s+rtsp:\/\/[^/]+(\/\S*)\s+RTSP/i.exec(head)
    const path = match === null ? '' : match[1]
    const cseq = /^CSeq:\s*(\d+)/im.exec(head)
    const cseqValue = cseq === null ? 0 : Number(cseq[1])
    const authorization = /^Authorization:\s*(.+)$/im.exec(head)
    rtspProbeLog.push({
      connectionId,
      cseq: cseqValue,
      auth: authorization !== null,
      path,
    })
    /* 同一连接内 CSeq 必须递增；重复或倒退直接拒绝。 */
    if (cseqValue <= lastCseq) {
      socket.write(`RTSP/1.0 400 Bad Request\r\nCSeq: ${cseqValue}\r\n\r\n`)
      return
    }
    lastCseq = cseqValue
    const codec = RTSP_CODECS.get(path)
    if (codec === undefined) {
      socket.write(`RTSP/1.0 404 Not Found\r\nCSeq: ${cseqValue}\r\n\r\n`)
      socket.end()
      return
    }
    /* nonce 绑定连接：没在本连接拿过挑战就带认证，一律重新挑战。 */
    if (authorization === null || (rtspBindNonce && nonce === '')) {
      nonce = rtspBindNonce ? `${RTSP_NONCE}-${connectionId}` : RTSP_NONCE
      write401(cseqValue)
      return
    }
    if (
      !rtspDigestOk(
        'DESCRIBE',
        `rtsp://127.0.0.1:${rtspPort}${path}`,
        path,
        authorization[1],
        nonce,
      )
    ) {
      write401(cseqValue)
      return
    }
    const sdp = rtspSdp(codec)
    socket.write(
      `RTSP/1.0 200 OK\r\nCSeq: ${cseqValue}\r\n` +
        `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n` +
        sdp,
    )
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
      const head = buffer.slice(0, end)
      buffer = buffer.slice(end + 4)
      handle(head)
    }
  })
  socket.on('error', () => {})
})

/* ---------- 代理服务器：用真的注册表，不绕过路由 ---------- */

const routes = []
const webCtx = {
  effect(fn) {
    return fn()
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}
registerCameraApi(webCtx)

const proxyServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://proxy')
  const route = routes.find((item) => item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  route.handler(req, res)
})

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

const cameraPort = await listen(cameraServer)
const rtspPort = await listen(rtspServer)
const proxyPort = await listen(proxyServer)
const base = `http://127.0.0.1:${proxyPort}/__dsh-terminal-workbench/camera`

async function post(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function newSession(overrides = {}) {
  const result = await post('/session', {
    host: '127.0.0.1',
    port: cameraPort,
    scheme: 'http',
    user: USER,
    password: PASSWORD,
    path: '/mjpeg',
    snapshotPath: '/snapshot',
    mode: 'mjpeg',
    ...overrides,
  })
  assert.strictEqual(result.status, 200, JSON.stringify(result.body))
  return result.body.id
}

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

await check('参数校验：Axis MJPEG 自动推导快照路径', () => {
  const config = __test.normalizeConfig({
    host: '10.0.0.1',
    path: '/axis-cgi/mjpg/video.cgi?fps=15',
    mode: 'mjpeg',
  })
  assert.strictEqual(config.snapshotPath, '/axis-cgi/jpg/image.cgi')
  assert.strictEqual(config.port, 80)
  assert.strictEqual(config.scheme, 'http')
})

await check('参数校验：RTSP 默认 554 / Axis 路径 / 口令百分号编码', () => {
  const config = __test.normalizeConfig({
    host: '192.168.10.20',
    user: 'root',
    password: 'p@ss:word',
    mode: 'rtsp',
  })
  assert.strictEqual(config.port, 554)
  assert.strictEqual(config.path, '/axis-media/media.amp?videocodec=h264')
  assert.strictEqual(
    config.rtspUrl,
    'rtsp://root:p%40ss%3Aword@192.168.10.20:554/axis-media/media.amp?videocodec=h264',
  )
  const encodedUser = __test.normalizeConfig({
    host: 'cam.local',
    user: 'a@b',
    password: 'p@ss',
    mode: 'rtsp',
  })
  assert.strictEqual(encodedUser.rtspUrl, 'rtsp://a%40b:p%40ss@cam.local:554/axis-media/media.amp?videocodec=h264')
})

await check('go2rtc 二进制发现：显式 env 优先，找不到返回空串', () => {
  const found = __test.resolveGo2rtcBinary({
    env: { DSH_GO2RTC_BIN: '/bin/sh', PATH: '' },
    home: '/nonexistent',
    pluginRoot: '/nonexistent',
  })
  assert.strictEqual(found, '/bin/sh')
  const missing = __test.resolveGo2rtcBinary({
    env: { DSH_GO2RTC_BIN: '/nonexistent', PATH: '' },
    home: '/nonexistent',
    pluginRoot: '/nonexistent',
  })
  assert.strictEqual(missing, '')
})

await check('参数校验：非法主机 / 端口 / 路径被拒', () => {
  assert.throws(() => __test.normalizeConfig({ host: 'a b' }), /相机地址不合法/)
  assert.throws(() => __test.normalizeConfig({ host: 'a', port: 0 }), /端口不合法/)
  assert.throws(() => __test.normalizeConfig({ host: 'a', path: 'no-slash' }), /流路径/)
  assert.throws(() => __test.normalizeConfig({ host: 'a', path: '/x', snapshotPath: 'bad' }), /快照路径/)
})

await check('建立会话返回随机 id，口令不进入 URL', async () => {
  const id = await newSession()
  assert.match(id, /^[a-f0-9]{32}$/)
  assert.ok(!id.includes(PASSWORD))
  assert.ok(!base.includes(PASSWORD))
})

await check('单张快照：Digest 认证后返回 JPEG', async () => {
  const id = await newSession()
  const response = await fetch(`${base}/snapshot?id=${id}`)
  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.headers.get('content-type'), 'image/jpeg')
  const body = Buffer.from(await response.arrayBuffer())
  assert.deepStrictEqual(body, JPEG)
})

await check('Digest 认证会被缓存：第二次请求不再 401 挑战', async () => {
  const id = await newSession()
  const before = digestChallenges
  await fetch(`${base}/snapshot?id=${id}`).then((r) => r.arrayBuffer())
  const afterFirst = digestChallenges
  await fetch(`${base}/snapshot?id=${id}`).then((r) => r.arrayBuffer())
  const afterSecond = digestChallenges
  assert.strictEqual(afterFirst - before, 1, '首次应挑战一次')
  assert.strictEqual(afterSecond - afterFirst, 0, '第二次应复用认证')
})

await check('MJPEG 直转：内容类型与帧边界原样透传', async () => {
  const id = await newSession()
  const response = await fetch(`${base}/stream?id=${id}`)
  assert.strictEqual(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /multipart\/x-mixed-replace/)
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1')
  assert.ok(text.includes('--mockframe'))
  assert.strictEqual((text.match(/--mockframe/g) ?? []).length, 2)
})

await check('快照模式：按帧轮询并包装成 MJPEG', async () => {
  const id = await newSession({ mode: 'snapshot', path: '/mjpeg' })
  const controller = new AbortController()
  const response = await fetch(`${base}/stream?id=${id}`, { signal: controller.signal })
  assert.strictEqual(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /multipart\/x-mixed-replace/)

  const reader = response.body.getReader()
  const decoder = new TextDecoder('latin1')
  let text = ''
  try {
    while ((text.match(/--dsh-camera-frame/g) ?? []).length < 2) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    if (error?.name !== 'AbortError') throw error
  }
  controller.abort()
  assert.ok((text.match(/--dsh-camera-frame/g) ?? []).length >= 2, '至少收到两帧')
})

await check('Basic 认证兜底', async () => {
  const id = await newSession({ path: '/basic', mode: 'snapshot', snapshotPath: '/basic' })
  const response = await fetch(`${base}/snapshot?id=${id}`)
  assert.strictEqual(response.status, 200)
  assert.strictEqual((await response.arrayBuffer()).byteLength, JPEG.length)
})

await check('错误口令返回 400，不泄漏内部堆栈', async () => {
  const id = await newSession({ password: 'wrong' })
  const response = await fetch(`${base}/snapshot?id=${id}`)
  assert.strictEqual(response.status, 400)
  const body = await response.json()
  assert.match(String(body.error), /HTTP 401/)
  assert.ok(!String(body.error).includes(PASSWORD))
})

await check('未知会话返回 404', async () => {
  const response = await fetch(`${base}/stream?id=deadbeef`)
  assert.strictEqual(response.status, 404)
})

await check('关闭会话后取流返回 404', async () => {
  const id = await newSession()
  const closed = await post('/close', { id })
  assert.strictEqual(closed.status, 200)
  const response = await fetch(`${base}/stream?id=${id}`)
  assert.strictEqual(response.status, 404)
})

await check('RTSP 会话：返回 wsUrl，流地址进 go2rtc，关闭时删流', async () => {
  const manager = __test.go2rtc
  const originalEnsure = manager.ensureStream
  const originalRemove = manager.removeStream
  const added = []
  const removed = []
  manager.ensureStream = async (name, url) => {
    added.push({ name, url })
    return `ws://127.0.0.1:9999/api/ws?src=${name}`
  }
  manager.removeStream = async (name) => {
    removed.push(name)
  }
  /* 不碰真机：默认路径判为存在（401），编码探测判为 H.264，保持原路径。 */
  __test.setRtspProbeImpl(async () => ({ status: 401, realm: 'AXIS_ACCC8E', server: 'Axis' }))
  __test.setRtspCodecProbeImpl(async () => ({
    status: 200,
    codecs: ['H264'],
    codec: 'H264',
    authFailed: false,
  }))
  try {
    const result = await post('/session', {
      host: '192.168.10.20',
      user: 'root',
      password: 'p@ss:word',
      mode: 'rtsp',
    })
    assert.strictEqual(result.status, 200, JSON.stringify(result.body))
    assert.strictEqual(result.body.mode, 'rtsp')
    assert.match(String(result.body.wsUrl), /^ws:\/\/127\.0\.0\.1:9999\/api\/ws\?src=cam_/)
    assert.strictEqual(added.length, 1)
    assert.strictEqual(
      added[0].url,
      'rtsp://root:p%40ss%3Aword@192.168.10.20:554/axis-media/media.amp?videocodec=h264',
    )

    const streamResponse = await fetch(`${base}/stream?id=${result.body.id}`)
    assert.strictEqual(streamResponse.status, 400)
    assert.match(String((await streamResponse.json()).error), /WebSocket/)

    const snapshotResponse = await fetch(`${base}/snapshot?id=${result.body.id}`)
    assert.strictEqual(snapshotResponse.status, 501)
    assert.match(String((await snapshotResponse.json()).error), /截图/)

    const closed = await post('/close', { id: result.body.id })
    assert.strictEqual(closed.status, 200)
    assert.deepStrictEqual(removed, [added[0].name])
  } finally {
    manager.ensureStream = originalEnsure
    manager.removeStream = originalRemove
    __test.setRtspProbeImpl(null)
  }
})

await check('RTSP 探测：404 判为路径不存在，401 判为路径存在', async () => {
  const missing = await __test.probeRtspDescribe({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/unknown/media.smp',
  })
  assert.strictEqual(missing.status, 404)
  const present = await __test.probeRtspDescribe({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
  })
  assert.strictEqual(present.status, 401)
  assert.strictEqual(present.realm, 'iPOLiS')
})

await check('品牌识别：安讯士路径 404 时自动切到韩华 profile3', async () => {
  const seen = []
  const result = await __test.detectRtspPath(
    { host: 'cam.local', port: 554, path: '/axis-media/media.amp?videocodec=h264' },
    {
      probe: async ({ path }) => {
        seen.push(path)
        return path === '/profile3/media.smp'
          ? { status: 401, realm: 'iPOLiS', server: '' }
          : { status: 404, realm: '', server: '' }
      },
    },
  )
  assert.strictEqual(result.path, '/profile3/media.smp')
  assert.strictEqual(result.brand, '韩华（iPOLiS）')
  assert.strictEqual(result.changed, true)
  assert.ok(seen.length >= 2)
})

await check('品牌识别：路径已存在（401）时保持原路径', async () => {
  const result = await __test.detectRtspPath(
    { host: 'cam.local', port: 554, path: '/axis-media/media.amp?videocodec=h264' },
    { probe: async () => ({ status: 401, realm: 'AXIS_ACCC8E', server: 'Axis' }) },
  )
  assert.strictEqual(result.path, '/axis-media/media.amp?videocodec=h264')
  assert.strictEqual(result.brand, '安讯士')
  assert.strictEqual(result.changed, false)
})

await check('品牌识别：相机不可达时不空扫候选路径', async () => {
  let calls = 0
  const result = await __test.detectRtspPath(
    { host: 'cam.local', port: 554, path: '/axis-media/media.amp' },
    {
      probe: async () => {
        calls += 1
        return { status: 0, realm: '', server: '', error: 'timeout' }
      },
    },
  )
  assert.strictEqual(calls, 1)
  assert.strictEqual(result.changed, false)
})

await check('品牌识别：只有内置路径允许自动纠正', () => {
  assert.strictEqual(__test.isBuiltinRtspPath('/axis-media/media.amp?videocodec=h264'), true)
  assert.strictEqual(__test.isBuiltinRtspPath('/profile3/media.smp'), true)
  assert.strictEqual(__test.isBuiltinRtspPath('/custom/stream'), false)
  assert.strictEqual(__test.isBuiltinRtspPath(''), false)
})

await check('品牌探测路由：返回识别到的品牌与纠正路径', async () => {
  __test.setRtspProbeImpl(async ({ path }) =>
    path === '/profile3/media.smp'
      ? { status: 401, realm: 'iPOLiS', server: '' }
      : { status: 404, realm: '', server: '' },
  )
  try {
    const result = await post('/probe', {
      host: '192.168.30.30',
      port: 554,
      path: '/axis-media/media.amp?videocodec=h264',
    })
    assert.strictEqual(result.status, 200, JSON.stringify(result.body))
    assert.strictEqual(result.body.path, '/profile3/media.smp')
    assert.strictEqual(result.body.brand, '韩华（iPOLiS）')
    assert.strictEqual(result.body.changed, true)
  } finally {
    __test.setRtspProbeImpl(null)
  }
})

await check('RTSP 会话：品牌路径不匹配时自动纠正后再拉流', async () => {
  const manager = __test.go2rtc
  const originalEnsure = manager.ensureStream
  const originalRemove = manager.removeStream
  const added = []
  manager.ensureStream = async (name, url) => {
    added.push(url)
    return `ws://127.0.0.1:9999/api/ws?src=${name}`
  }
  manager.removeStream = async () => {}
  __test.setRtspProbeImpl(async ({ path }) =>
    path === '/profile3/media.smp'
      ? { status: 401, realm: 'iPOLiS', server: '' }
      : { status: 404, realm: '', server: '' },
  )
  __test.setRtspCodecProbeImpl(async () => ({
    status: 200,
    codecs: ['H264'],
    codec: 'H264',
    authFailed: false,
  }))
  try {
    const result = await post('/session', {
      host: '192.168.30.30',
      user: 'root',
      password: 'secret',
      mode: 'rtsp',
    })
    assert.strictEqual(result.status, 200, JSON.stringify(result.body))
    assert.strictEqual(result.body.path, '/profile3/media.smp')
    assert.strictEqual(result.body.brand, '韩华（iPOLiS）')
    assert.strictEqual(result.body.detected, true)
    assert.deepStrictEqual(added, ['rtsp://root:secret@192.168.30.30:554/profile3/media.smp'])
    await post('/close', { id: result.body.id })
  } finally {
    manager.ensureStream = originalEnsure
    manager.removeStream = originalRemove
    __test.setRtspProbeImpl(null)
    __test.setRtspCodecProbeImpl(null)
  }
})

await check('编码预检只覆盖可能输出 H.265 的路径', () => {
  assert.strictEqual(__test.needsCodecCheck('/profile3/media.smp'), true)
  assert.strictEqual(__test.needsCodecCheck('/Streaming/Channels/101'), true)
  assert.strictEqual(
    __test.needsCodecCheck('/cam/realmonitor?channel=1&subtype=0'),
    true,
  )
  assert.strictEqual(__test.needsCodecCheck('/axis-media/media.amp'), true)
  assert.strictEqual(
    __test.needsCodecCheck('/axis-media/media.amp?videocodec=h264'),
    false,
  )
  assert.strictEqual(__test.needsCodecCheck('/Streaming/Channels/102'), false)
  assert.strictEqual(
    __test.needsCodecCheck('/cam/realmonitor?channel=1&subtype=1'),
    false,
  )
})

await check('编码探测：401 挑战后用 Digest 读到 SDP 的 H.265 / H.264', async () => {
  const unauth = await __test.probeRtspCodec({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
    user: '',
    password: '',
  })
  assert.strictEqual(unauth.status, 401)
  assert.strictEqual(unauth.authRequired, true)

  const h265 = await __test.probeRtspCodec({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(h265.status, 200, JSON.stringify(h265))
  assert.deepStrictEqual(h265.codecs, ['H265'])
  assert.strictEqual(h265.codec, 'H265')

  const h264 = await __test.probeRtspCodec({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile2/media.smp',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(h264.status, 200, JSON.stringify(h264))
  assert.strictEqual(h264.codec, 'H264')
})

await check('编码探测：401 挑战与认证请求在同一连接，CSeq 递增', async () => {
  __test.clearCodecCache()
  const before = rtspProbeLog.length
  const result = await __test.probeRtspCodec({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile2/media.smp',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(result.status, 200, JSON.stringify(result))
  const entries = rtspProbeLog
    .slice(before)
    .filter((item) => item.path === '/profile2/media.smp')
  assert.strictEqual(entries.length, 2, JSON.stringify(entries))
  assert.strictEqual(entries[0].auth, false)
  assert.strictEqual(entries[1].auth, true)
  assert.strictEqual(entries[0].connectionId, entries[1].connectionId)
  assert.deepStrictEqual(entries.map((item) => item.cseq), [1, 2])
})

await check('编码探测：相机 401 后断开且 nonce 不绑连接时仍能认证', async () => {
  rtspBindNonce = false
  rtspCloseAfterChallenge = true
  try {
    const result = await __test.probeRtspCodec({
      host: '127.0.0.1',
      port: rtspPort,
      path: '/profile2/media.smp',
      user: USER,
      password: PASSWORD,
    })
    assert.strictEqual(result.status, 200, JSON.stringify(result))
    assert.strictEqual(result.codec, 'H264')
  } finally {
    rtspBindNonce = true
    rtspCloseAfterChallenge = false
  }
})

await check('认证挑战：Basic 与 Digest 同时出现时优先 Digest，realm 不被覆盖', () => {
  const challenge = __test.parseChallenge(
    'Basic realm="camera", Digest realm="iPOLiS", nonce="abc", qop="auth", Basic realm="fallback"',
  )
  assert.strictEqual(challenge.type, 'digest')
  assert.strictEqual(challenge.params.realm, 'iPOLiS')
  assert.strictEqual(challenge.params.nonce, 'abc')
  assert.strictEqual(challenge.params.qop, 'auth')
})

await check('H.264 查找：韩华 profile3 是 H.265 时自动找到 profile2', async () => {
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  const result = await __test.detectH264Path({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(result.changed, true)
  assert.strictEqual(result.path, '/profile2/media.smp')
  assert.strictEqual(result.codec, 'H264')
  const paths = result.profiles.map((item) => item.path)
  assert.ok(paths.includes('/profile1/media.smp'))
  assert.ok(paths.includes('/profile2/media.smp'))
})

await check('H.264 查找：海康主码流 101 是 H.265 时切到 102', async () => {
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  const result = await __test.detectH264Path({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/Streaming/Channels/101',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(result.changed, true)
  assert.strictEqual(result.path, '/Streaming/Channels/102')
  assert.strictEqual(result.codec, 'H264')
})

await check('H.264 查找：安讯士已指定 videocodec=h264 时不改路径', async () => {
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  const result = await __test.detectH264Path({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/axis-media/media.amp?videocodec=h264',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(result.changed, false)
  assert.strictEqual(result.path, '/axis-media/media.amp?videocodec=h264')
  assert.strictEqual(result.codec, 'H264')
})

await check('H.264 查找：密码错误立即返回，不空扫其它 profile', async () => {
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  const result = await __test.detectH264Path({
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
    user: USER,
    password: 'wrong-password',
  })
  assert.strictEqual(result.authFailed, true)
  assert.strictEqual(result.changed, false)
  assert.strictEqual(result.profiles.length, 1)
})

await check('编码路由：返回 H.264 路径，响应不包含口令', async () => {
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  const result = await post('/codec', {
    host: '127.0.0.1',
    port: rtspPort,
    path: '/profile3/media.smp',
    user: USER,
    password: PASSWORD,
  })
  assert.strictEqual(result.status, 200, JSON.stringify(result.body))
  assert.strictEqual(result.body.changed, true)
  assert.strictEqual(result.body.path, '/profile2/media.smp')
  assert.strictEqual(result.body.codec, 'H264')
  assert.ok(!JSON.stringify(result.body).includes(PASSWORD), '响应不应回显口令')
})

await check('RTSP 会话：H.265 自动切 H.264 profile 后再拉流', async () => {
  const manager = __test.go2rtc
  const originalEnsure = manager.ensureStream
  const originalRemove = manager.removeStream
  const added = []
  manager.ensureStream = async (name, url) => {
    added.push(url)
    return `ws://127.0.0.1:9999/api/ws?src=${name}`
  }
  manager.removeStream = async () => {}
  __test.setRtspProbeImpl(async () => ({ status: 401, realm: 'iPOLiS', server: '' }))
  __test.clearCodecCache()
  __test.setRtspCodecProbeImpl(null)
  try {
    const result = await post('/session', {
      host: '127.0.0.1',
      port: rtspPort,
      path: '/profile3/media.smp',
      user: USER,
      password: PASSWORD,
      mode: 'rtsp',
    })
    assert.strictEqual(result.status, 200, JSON.stringify(result.body))
    assert.strictEqual(result.body.path, '/profile2/media.smp')
    assert.strictEqual(result.body.originalPath, '/profile3/media.smp')
    assert.strictEqual(result.body.codecChanged, true)
    assert.strictEqual(result.body.codec, 'H264')
    assert.deepStrictEqual(added, [
      `rtsp://${USER}:${PASSWORD}@127.0.0.1:${rtspPort}/profile2/media.smp`,
    ])
    await post('/close', { id: result.body.id })
  } finally {
    manager.ensureStream = originalEnsure
    manager.removeStream = originalRemove
    __test.setRtspProbeImpl(null)
    __test.setRtspCodecProbeImpl(null)
  }
})

await check('go2rtc 临时目录优先 tmpfs，缺失时回退系统临时目录', () => {
  const root = __test.go2rtcTempRoot({ shm: '/dev/shm', tmpdir: '/tmp' })
  assert.ok(root === '/dev/shm' || root === '/tmp')
  assert.strictEqual(
    __test.go2rtcTempRoot({ shm: '/definitely-not-a-real-dsh-shm', tmpdir: '/tmp' }),
    '/tmp',
  )
})

await check('流名按 RTSP 地址哈希：同址同名，不同址不同名，不泄露口令', () => {
  const first = __test.streamNameForUrl('rtsp://root:secret@192.168.10.20:554/axis-media/media.amp')
  const second = __test.streamNameForUrl('rtsp://root:secret@192.168.10.20:554/axis-media/media.amp')
  const other = __test.streamNameForUrl('rtsp://root:secret@192.168.10.21:554/axis-media/media.amp')
  assert.strictEqual(first, second)
  assert.notStrictEqual(first, other)
  assert.match(first, /^cam_[a-f0-9]{12}$/)
  assert.ok(!first.includes('secret'))
})

await check('go2rtc 流引用计数：同流多开只拉一次，全部关闭才删', async () => {
  const manager = new __test.Go2rtcManager({ idleMs: 60_000 })
  manager.child = {}
  manager.port = 9999
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }
  try {
    const name = 'cam_refcount'
    await manager.ensureStream(name, 'rtsp://example/stream')
    await manager.ensureStream(name, 'rtsp://example/stream')
    assert.strictEqual(calls.filter((item) => item.method === 'PUT').length, 1)
    assert.strictEqual(manager.streams.get(name).refs, 2)
    await manager.removeStream(name)
    assert.strictEqual(calls.filter((item) => item.method === 'DELETE').length, 0)
    assert.strictEqual(manager.streams.get(name).refs, 1)
    await manager.removeStream(name)
    assert.strictEqual(calls.filter((item) => item.method === 'DELETE').length, 1)
    assert.strictEqual(manager.streams.has(name), false)
  } finally {
    globalThis.fetch = originalFetch
    manager.cancelIdle()
  }
})

await check('播放器路由返回同源 VideoRTC 模块', async () => {
  const response = await fetch(`${base}/player.js`)
  assert.strictEqual(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/javascript/)
  assert.strictEqual(response.headers.get('cache-control'), 'no-cache')
  assert.ok(response.headers.get('etag'), '应带 ETag')
  const text = await response.text()
  assert.ok(text.includes('export class VideoRTC'), '应包含 VideoRTC 导出')
  assert.ok(text.includes('MIT'), '应保留 MIT 许可头')
})

await check('播放器使用低延迟缓冲：2 秒窗口 + 温和追帧', async () => {
  const response = await fetch(`${base}/player.js`)
  const text = await response.text()
  assert.ok(text.includes('const start = end - 2'), '缓冲窗口应为 2 秒')
  assert.ok(text.includes('gap > 1.2'), '落后超过 1.2 秒应直接跳到直播点')
  assert.ok(!text.includes('this.video.playbackRate = gap > 0.1 ? gap : 0.1'), '不应保留原版的 0.1 倍速追帧')
})

await check('播放器路由：带版本号可长期缓存，gzip 与 304 生效', async () => {
  const response = await fetch(`${base}/player.js?v=test`, {
    headers: { 'accept-encoding': 'gzip' },
  })
  assert.strictEqual(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /immutable/)
  assert.strictEqual(response.headers.get('content-encoding'), 'gzip')
  const etag = response.headers.get('etag')
  assert.ok(etag)
  await response.text()
  const cached = await fetch(`${base}/player.js?v=test`, {
    headers: { 'if-none-match': etag },
  })
  assert.strictEqual(cached.status, 304)
  await cached.arrayBuffer()
})

await check('错误方法返回 405', async () => {
  const response = await fetch(`${base}/session`)
  assert.strictEqual(response.status, 405)
  const body = await response.json()
  assert.match(String(body.error), /POST/)
})

await check('非法参数返回 400', async () => {
  const result = await post('/session', { host: 'bad host' })
  assert.strictEqual(result.status, 400)
  assert.match(String(result.body.error), /相机地址不合法/)
})

console.log(`\n== 相机代理：${passed}/${passed + failures.length} 通过`)
proxyServer.close()
cameraServer.close()
rtspServer.close()
if (failures.length > 0) process.exitCode = 1
