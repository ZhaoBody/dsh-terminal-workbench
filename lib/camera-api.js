/**
 * dsh-terminal-workbench — 相机取流代理（宿主侧）。
 *
 * 为什么必须走宿主：
 * 1. 相机网页带 `X-Frame-Options: SAMEORIGIN` / CSP `frame-ancestors 'self'`，
 *    浏览器 iframe 直接嵌会空白；
 * 2. 相机多用 Digest 认证，`<img>` 标签没法自己带认证头；
 * 3. RTSP 浏览器不能直接播，但 Axis 等相机同时提供 HTTP MJPEG / JPEG 快照，
 *    宿主把认证和取流做掉，浏览器只看到同源的 multipart 流。
 *
 * 数据流：
 *   浏览器 POST /camera/session { host, port, scheme, user, password, path, mode }
 *     → 宿主记住配置，返回随机 id（密码不出现在 URL 里）
 *   浏览器 <img src="/camera/stream?id=…">
 *     → 宿主用 Digest/Basic 认证连相机
 *       · mode=mjpeg   ：直接转发相机的 multipart/x-mixed-replace
 *       · mode=snapshot：按帧轮询 JPEG，再包成 multipart 流
 *
 * 安全边界：
 * - 只允许 http/https，host 只允许主机名/IP 字符，path 必须以 / 开头；
 * - 会话 id 随机、内存态、带 TTL，URL 里不出现相机口令；
 * - 不跟随重定向（避免被相机带到任意地址）；
 * - 单条流在浏览器断开时立刻销毁上游请求。
 *
 * @module dsh-terminal-workbench/camera-api
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { rmSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** 会话空闲多久后回收。流持续打开时不会过期。 */
const SESSION_TTL_MS = 30 * 60 * 1000
/** 清理定时器间隔。 */
const SWEEP_MS = 60 * 1000
/** 单次取流/快照的连接超时。 */
const CONNECT_TIMEOUT_MS = 10 * 1000
/** 快照轮询默认间隔（4 fps）；可在 path 里用 `fps=` 自行调相机的帧率。 */
const SNAPSHOT_INTERVAL_MS = 250
/** 单个 JPEG 帧上限，防止坏相机把内存打满。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** MJPEG 输出边界。 */
const BOUNDARY = 'dsh-camera-frame'

const PREFIX = '/__dsh-terminal-workbench/camera'

/** RTSP 默认路径（Axis H.264）。其它品牌由书签里的预设填写。 */
const RTSP_DEFAULT_PATH = '/axis-media/media.amp?videocodec=h264'
/** 吊具相机（Axis 一拖四 .34 主机）默认走第 5 路。 */
const RTSP_SPREADER_PATH = '/axis-media/media.amp?videocodec=h264&camera=5'

/** 韩华（iPOLiS）的 6 条码流 profile；具体哪条是 H.264 要读 SDP 才知道。 */
const HANWHA_PROFILE_PATHS = Array.from(
  { length: 6 },
  (_, index) => `/profile${index + 1}/media.smp`,
)

/**
 * 当前路径是 H.265 时，同品牌里值得再试的 H.264 候选。
 *
 * 浏览器 MSE 只稳定支持 H.264；H.265 在 go2rtc 里会报
 * `codecs not matched: video:H265 ... => video:JPEG`。韩华/海康/大华的
 * 主码流常是 H.265，子码流或另一个 profile 往往是 H.264，这里按品牌
 * 给出同一台相机内的候选，不跨品牌乱扫。
 */
const RTSP_H264_FALLBACKS = [
  { match: /^\/profile[1-6]\/media\.smp$/, paths: HANWHA_PROFILE_PATHS },
  {
    match: /^\/Streaming\/Channels\/10[12]$/,
    paths: ['/Streaming/Channels/102', '/Streaming/Channels/101'],
  },
  {
    match: /^\/cam\/realmonitor\?.*subtype=[01]/,
    paths: [
      '/cam/realmonitor?channel=1&subtype=1',
      '/cam/realmonitor?channel=1&subtype=0',
    ],
  },
  {
    match: /^\/axis-media\/media\.amp(\?.*)?$/,
    paths: ['/axis-media/media.amp?videocodec=h264'],
  },
]

/**
 * 现场常见品牌的 RTSP 路径候选。
 *
 * 为什么需要它：相机书签默认按安讯士路径填写，换成韩华/海康/大华时
 * DESCRIBE 会直接 404，go2rtc 报 `wrong response on DESCRIBE`，画面全黑。
 * 这里用**不带口令的 DESCRIBE** 探测路径是否存在：401/200 说明路径存在，
 * 404/400 说明品牌不对。401 只代表需要认证，不会建立 RTSP 会话。
 */
const RTSP_PATH_CANDIDATES = [
  { brand: '韩华（iPOLiS）', path: '/profile3/media.smp' },
  { brand: '安讯士', path: '/axis-media/media.amp?videocodec=h264' },
  { brand: '安讯士', path: '/axis-media/media.amp' },
  { brand: '海康', path: '/Streaming/Channels/101' },
  { brand: '海康（子码流）', path: '/Streaming/Channels/102' },
  { brand: '大华', path: '/cam/realmonitor?channel=1&subtype=0' },
  { brand: '大华（子码流）', path: '/cam/realmonitor?channel=1&subtype=1' },
]

/**
 * 只有这些路径值得在建立会话前读 SDP：它们最可能输出 H.265。
 * 安讯士已经显式写了 `videocodec=h264` 的路径不用再探测，省一次连接。
 */
function needsCodecCheck(path) {
  const text = String(path ?? '').trim()
  if (/^\/profile[1-6]\/media\.smp$/.test(text)) return true
  if (/^\/Streaming\/Channels\/101$/.test(text)) return true
  if (/^\/cam\/realmonitor\?.*subtype=0(?:&|$)/.test(text)) return true
  if (/^\/axis-media\/media\.amp(?:\?.*)?$/.test(text)) {
    return !/[?&]videocodec=h264(?:&|$)/.test(text)
  }
  return false
}

/** 只有内置路径才允许自动纠正，用户手填的路径一律不动。 */
const RTSP_BUILTIN_PATHS = new Set([
  RTSP_DEFAULT_PATH,
  RTSP_SPREADER_PATH,
  ...HANWHA_PROFILE_PATHS,
  ...RTSP_PATH_CANDIDATES.map((item) => item.path),
])
/** go2rtc 没有消费者后多久退出，别让一个闲置进程常驻。 */
const GO2RTC_IDLE_MS = 180 * 1000
/** go2rtc 启动后等待 API 就绪的上限。 */
const GO2RTC_READY_TIMEOUT_MS = 8 * 1000

const PLAYER_FILE = fileURLToPath(new URL('./go2rtc-player.js', import.meta.url))

/** 播放器源码只读一次，并预压缩；重复打开相机标签不再反复读盘/压缩。 */
let playerAsset = null

async function getPlayerAsset() {
  if (playerAsset !== null) return playerAsset
  const source = await readFile(PLAYER_FILE)
  const etag = `"${crypto.createHash('sha1').update(source).digest('hex').slice(0, 16)}"`
  playerAsset = { source, gzip: gzipSync(source), etag }
  return playerAsset
}

/**
 * 同一个 RTSP 地址只保留一条 go2rtc 流：流名取 URL 的哈希，
 * 多开同一台相机时共享拉流与转封装，关掉其中一个标签不会误删另一条。
 */
function streamNameForUrl(url) {
  const digest = crypto.createHash('sha1').update(String(url)).digest('hex')
  return `cam_${digest.slice(0, 12)}`
}

/** RTSP DESCRIBE 探测结果的短缓存：同一条路径 5 分钟内不重复探测。 */
const RTSP_PROBE_TTL_MS = 5 * 60 * 1000
const RTSP_PROBE_CACHE_LIMIT = 200
const rtspProbeCache = new Map()

/** 从 Digest realm / Server 头猜品牌，只用于界面提示。 */
function rtspBrandOf(realm, server) {
  const text = `${realm ?? ''} ${server ?? ''}`.toLowerCase()
  if (text.includes('ipolis')) return '韩华（iPOLiS）'
  if (text.includes('axis')) return '安讯士'
  if (text.includes('hikvision') || text.includes('ds-')) return '海康'
  if (text.includes('dahua')) return '大华'
  return ''
}

/**
 * 不带口令的 RTSP DESCRIBE：只读状态行和 WWW-Authenticate。
 *
 * 路径不存在时相机回 404（韩华实测），路径存在但需要认证时回 401。
 * 401 只是认证挑战，不会建立 RTSP 会话，也不会把密码发出去。
 * 网络不通（status=0）不进缓存，避免相机临时掉线后 5 分钟内都直接失败。
 */
function probeRtspDescribe({ host, port, path, timeoutMs = 1500 }) {
  const key = `${host}:${port}${path}`
  const cached = rtspProbeCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < RTSP_PROBE_TTL_MS) {
    return Promise.resolve({ ...cached.result, cached: true })
  }
  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (result.status > 0) {
        if (rtspProbeCache.size >= RTSP_PROBE_CACHE_LIMIT) {
          const oldest = rtspProbeCache.keys().next().value
          if (oldest !== undefined) rtspProbeCache.delete(oldest)
        }
        rtspProbeCache.set(key, { at: Date.now(), result })
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ status: 0, realm: '', server: '', error: 'timeout' }),
      timeoutMs,
    )
    socket.on('connect', () => {
      socket.write(
        `DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\n` +
          'CSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: dsh-terminal-workbench\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.slice(0, end)
      const statusMatch = /^RTSP\/\d\.\d\s+(\d{3})/.exec(head)
      const realmMatch = /realm="([^"]*)"/i.exec(head)
      const serverMatch = /^Server:\s*(.+)$/im.exec(head)
      finish({
        status: statusMatch === null ? 0 : Number(statusMatch[1]),
        realm: realmMatch === null ? '' : realmMatch[1],
        server: serverMatch === null ? '' : serverMatch[1].trim(),
      })
    })
    socket.on('error', (error) => finish({ status: 0, realm: '', server: '', error: String(error) }))
  })
}

/** 解析 RTSP 响应头；返回 null 表示还没收全。 */
function parseRtspResponseHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return null
  const lines = buffer.slice(0, end).toString('utf8').split('\r\n')
  const statusMatch = /^RTSP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '')
  const headers = Object.create(null)
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`
  }
  return {
    status: statusMatch === null ? 0 : Number(statusMatch[1]),
    headers,
    bodyOffset: end + 4,
  }
}

/**
 * 一条 RTSP TCP 连接，同一连接上按 CSeq 递增发多个 DESCRIBE。
 *
 * 401 挑战和带认证的重试必须落在同一条连接上：韩华 iPOLiS 这类相机会
 * 把 nonce 绑在连接上，换一条连接拿旧 nonce 算 Digest 会被判 401，
 * 看起来就像「账号密码错误」。相机不可达时返回 status=0，不抛异常。
 */
function createRtspSession({ host, port, timeoutMs = 2500 }) {
  const socket = net.connect({ host, port })
  let buffer = Buffer.alloc(0)
  let pending = null
  let closed = false

  const settle = (result) => {
    if (pending === null) return
    const current = pending
    pending = null
    if (current.timer !== null) clearTimeout(current.timer)
    if (current.bodyTimer !== null) clearTimeout(current.bodyTimer)
    current.resolve(result)
  }

  const fail = (error) => {
    if (closed) return
    closed = true
    settle({ status: 0, headers: Object.create(null), body: '', error })
    socket.destroy()
  }

  const deliver = () => {
    if (pending === null) return
    /* 跳过 RTP 交织帧（`$` + 2 字节长度）；DESCRIBE 阶段一般没有，防一手。 */
    while (buffer.length >= 4 && buffer[0] === 0x24) {
      const length = buffer.readUInt16BE(2)
      if (buffer.length < 4 + length) return
      buffer = buffer.subarray(4 + length)
    }
    const parsed = parseRtspResponseHead(buffer)
    if (parsed === null) return
    const rawLength = parsed.headers['content-length']
    const length = rawLength === undefined ? Number.NaN : Number(rawLength)
    if (parsed.status !== 200) {
      /* 非 200 一般没有正文；有 Content-Length 就一起吃掉，别污染下一次响应。 */
      if (Number.isFinite(length) && length > 0) {
        if (buffer.length - parsed.bodyOffset < length) return
        buffer = buffer.subarray(parsed.bodyOffset + length)
      } else {
        buffer = buffer.subarray(parsed.bodyOffset)
      }
      settle({ status: parsed.status, headers: parsed.headers, body: '' })
      return
    }
    if (Number.isFinite(length) && length >= 0) {
      if (buffer.length - parsed.bodyOffset < length) return
      const body = buffer.subarray(parsed.bodyOffset, parsed.bodyOffset + length).toString('utf8')
      buffer = buffer.subarray(parsed.bodyOffset + length)
      settle({ status: 200, headers: parsed.headers, body })
      return
    }
    /* 没有 Content-Length 的相机：头到齐后再等一小会儿收正文。 */
    if (pending.bodyTimer === null) {
      pending.bodyTimer = setTimeout(() => {
        if (pending === null) return
        const body = buffer.subarray(parsed.bodyOffset).toString('utf8')
        buffer = Buffer.alloc(0)
        settle({ status: 200, headers: parsed.headers, body })
      }, 120)
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    deliver()
  })
  socket.on('error', (error) => fail(String(error)))
  socket.on('close', () => fail('closed'))

  return {
    get closed() {
      return closed
    },
    describe({ path, cseq, authorization }) {
      return new Promise((resolve) => {
        if (closed) {
          resolve({ status: 0, headers: Object.create(null), body: '', error: 'closed' })
          return
        }
        const target = `rtsp://${host}:${port}${path}`
        const lines = [
          `DESCRIBE ${target} RTSP/1.0`,
          `CSeq: ${cseq}`,
          'Accept: application/sdp',
          'User-Agent: dsh-terminal-workbench',
        ]
        if (authorization !== undefined) lines.push(`Authorization: ${authorization}`)
        const timer = setTimeout(
          () => settle({ status: 0, headers: Object.create(null), body: '', error: 'timeout' }),
          timeoutMs,
        )
        pending = { resolve, timer, bodyTimer: null }
        try {
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        } catch (error) {
          settle({ status: 0, headers: Object.create(null), body: '', error: String(error) })
        }
      })
    },
    close() {
      closed = true
      socket.destroy()
    },
  }
}

/** 从 SDP 里取视频编码名，例如 H264 / H265 / JPEG。 */
function parseSdpVideoCodecs(sdp) {
  const codecs = []
  let inVideo = false
  for (const rawLine of String(sdp ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video')
      continue
    }
    if (!inVideo) continue
    const match = /^a=rtpmap:\d+\s+([^/\s]+)\//i.exec(line)
    if (match === null) continue
    const codec = match[1].toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (codec !== '' && codecs.indexOf(codec) < 0) codecs.push(codec)
  }
  return codecs
}

/**
 * 带认证读一条 RTSP 路径的 SDP，返回视频编码。
 *
 * 在同一条 TCP 连接上先发不带口令的 DESCRIBE 拿 401 挑战，再用
 * Digest/Basic 重试（CSeq 递增）；个别相机只按路径算 Digest，会在
 * 同一连接上再试一次路径形式。口令只用于计算 Authorization 头，
 * 不拼进 URL，也不进日志。
 */
async function probeRtspCodec({ host, port, path, user, password, timeoutMs = 2500 }) {
  const target = `rtsp://${host}:${port}${path}`
  const credentials = { user, password }
  const openSession = () => createRtspSession({ host, port, timeoutMs })
  let session = openSession()

  const authorizationFor = (current, uri, nc) =>
    current.type === 'basic'
      ? basicAuthorization(credentials)
      : digestAuthorization(credentials, current, 'DESCRIBE', uri, nc)

  /* 在一条连接上把绝对 URI / 路径 URI 依次试完；CSeq 从 cseqStart 递增。 */
  const tryAuthenticated = async (initialChallenge, uris, cseqStart) => {
    let current = initialChallenge
    let response = null
    let cseq = cseqStart
    let ncCount = 0
    for (const uri of uris) {
      cseq += 1
      ncCount += 1
      response = await session.describe({
        path,
        cseq,
        authorization: authorizationFor(current, uri, String(ncCount).padStart(8, '0')),
      })
      if (response.status === 200) return { response, challenge: current, closed: false }
      if (response.status !== 401) return { response, challenge: current, closed: session.closed }
      /* 相机可能刷新 nonce（stale）；后续重试用新挑战。 */
      current = parseChallenge(response.headers['www-authenticate']) ?? current
      if (session.closed) return { response, challenge: current, closed: true }
    }
    return { response, challenge: current, closed: session.closed }
  }

  try {
    const first = await session.describe({ path, cseq: 1 })
    if (first.status !== 401) {
      const codecs = first.status === 200 ? parseSdpVideoCodecs(first.body) : []
      return {
        status: first.status,
        codecs,
        codec: codecs.indexOf('H264') >= 0 ? 'H264' : codecs[0] ?? '',
        authFailed: false,
      }
    }

    let challenge = parseChallenge(first.headers['www-authenticate'])
    if (challenge === null) {
      return { status: 401, codecs: [], codec: '', authFailed: true }
    }
    if (user === '' || password === '') {
      return { status: 401, codecs: [], codec: '', authFailed: true, authRequired: true }
    }
    if (challenge.type === 'digest') {
      const algorithm = String(challenge.params.algorithm ?? 'MD5').toUpperCase()
      if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') {
        return {
          status: 401,
          codecs: [],
          codec: '',
          authFailed: true,
          error: `相机使用不支持的 Digest 算法：${algorithm}`,
        }
      }
    }

    /* 绝对 URI 优先；Digest 相机失败再试只算路径的写法。 */
    const uris = challenge.type === 'digest' ? [target, path] : [target]
    let outcome = await tryAuthenticated(challenge, uris, 1)

    /*
     * 相机在挑战或认证后主动断开：换一条连接。
     * 先重新挑战（nonce 绑连接的相机）；如果它连挑战后都断开，
     * 再用最后拿到的挑战直接认证（nonce 不绑连接的相机）。
     */
    if (outcome.closed && outcome.response.status !== 200) {
      session.close()
      session = openSession()
      const again = await session.describe({ path, cseq: 1 })
      if (again.status === 401) {
        challenge = parseChallenge(again.headers['www-authenticate']) ?? outcome.challenge
        outcome = await tryAuthenticated(challenge, uris, 1)
        if (outcome.closed && outcome.response.status !== 200) {
          session.close()
          session = openSession()
          let response = await session.describe({
            path,
            cseq: 1,
            authorization: authorizationFor(outcome.challenge, uris[0], '00000001'),
          })
          if (response.status === 401 && uris.length > 1 && !session.closed) {
            response = await session.describe({
              path,
              cseq: 2,
              authorization: authorizationFor(outcome.challenge, uris[1], '00000002'),
            })
          }
          outcome = { response, challenge: outcome.challenge, closed: session.closed }
        }
      } else {
        outcome = { response: again, challenge, closed: session.closed }
      }
    }

    const response = outcome.response
    if (response.status !== 200) {
      return {
        status: response.status,
        codecs: [],
        codec: '',
        authFailed: response.status === 401,
      }
    }
    const codecs = parseSdpVideoCodecs(response.body)
    return {
      status: 200,
      codecs,
      codec: codecs.indexOf('H264') >= 0 ? 'H264' : codecs[0] ?? '',
      authFailed: false,
    }
  } finally {
    session.close()
  }
}

/** 编码探测缓存：同一路径 2 分钟内不重复读 SDP。 */
const RTSP_CODEC_TTL_MS = 2 * 60 * 1000
const RTSP_CODEC_CACHE_LIMIT = 200
const rtspCodecCache = new Map()

function codecCacheKey(host, port, path) {
  return `${host}:${port}${path}`
}

function cachedCodec(key) {
  const cached = rtspCodecCache.get(key)
  if (cached === undefined || Date.now() - cached.at >= RTSP_CODEC_TTL_MS) return null
  return cached.result
}

function rememberCodec(key, result) {
  if (rtspCodecCache.size >= RTSP_CODEC_CACHE_LIMIT) {
    const oldest = rtspCodecCache.keys().next().value
    if (oldest !== undefined) rtspCodecCache.delete(oldest)
  }
  rtspCodecCache.set(key, { at: Date.now(), result })
}

/** 测试用：清掉编码缓存，避免不同用例互相影响。 */
function clearCodecCache() {
  rtspCodecCache.clear()
}

/**
 * 在相机内找 H.264 码流。
 *
 * 只在当前路径明确返回 200 且是 H.265 时才扫同品牌候选；相机不可达
 * （status=0）或认证失败时立刻返回，避免一个掉线相机把候选路径全扫一遍。
 */
async function detectH264Path(config, options = {}) {
  const probe = options.probe ?? rtspCodecProbeImpl
  const current = String(config.path ?? '')
  const result = {
    path: current,
    codec: '',
    changed: false,
    authFailed: false,
    authRequired: false,
    profiles: [],
  }
  if (config.user === '' || config.password === '') {
    result.authRequired = true
    return result
  }

  const probeOne = async (path) => {
    const key = codecCacheKey(config.host, config.port, path)
    const cached = cachedCodec(key)
    if (cached !== null) return cached
    const info = await probe({
      host: config.host,
      port: config.port,
      path,
      user: config.user,
      password: config.password,
    })
    if (info.status === 200) rememberCodec(key, info)
    return info
  }

  const first = await probeOne(current)
  result.profiles.push({ path: current, codec: first.codec ?? '', status: first.status ?? 0 })
  if (first.status !== 200) {
    result.authFailed = first.status === 401
    result.codec = first.codec ?? ''
    return result
  }
  if (Array.isArray(first.codecs) && first.codecs.indexOf('H264') >= 0) {
    result.codec = 'H264'
    return result
  }
  result.codec = first.codec ?? ''

  const fallback = RTSP_H264_FALLBACKS.find((item) => item.match.test(current))
  if (fallback === undefined) return result
  for (const path of fallback.paths) {
    if (path === current) continue
    const info = await probeOne(path)
    result.profiles.push({ path, codec: info.codec ?? '', status: info.status ?? 0 })
    if (info.status === 200 && Array.isArray(info.codecs) && info.codecs.indexOf('H264') >= 0) {
      result.path = path
      result.codec = 'H264'
      result.changed = true
      return result
    }
  }
  return result
}

/** 测试可替换的探测实现；生产永远是 probeRtspDescribe。 */
let rtspProbeImpl = probeRtspDescribe
function setRtspProbeImpl(impl) {
  rtspProbeImpl = typeof impl === 'function' ? impl : probeRtspDescribe
}

/** 测试可替换的编码探测实现；生产永远是 probeRtspCodec。 */
let rtspCodecProbeImpl = probeRtspCodec
function setRtspCodecProbeImpl(impl) {
  rtspCodecProbeImpl = typeof impl === 'function' ? impl : probeRtspCodec
}

/** 内置默认路径才允许自动纠正；用户手填的路径不动。 */
function isBuiltinRtspPath(path) {
  return RTSP_BUILTIN_PATHS.has(String(path ?? '').trim())
}

/**
 * 探测当前路径；404/400 时按品牌候选表找一条能走到认证的路径。
 * probe 可注入，测试不需要真的开 RTSP 服务器。
 */
async function detectRtspPath(config, options = {}) {
  const probe = options.probe ?? rtspProbeImpl
  const candidates = options.candidates ?? RTSP_PATH_CANDIDATES
  const first = await probe({ host: config.host, port: config.port, path: config.path })
  const brand = rtspBrandOf(first.realm, first.server)
  /* 401 / 200 / 403 都说明路径存在；0 是网络不通，没必要再扫候选。 */
  if (first.status !== 400 && first.status !== 404) {
    return {
      path: config.path,
      brand,
      realm: first.realm ?? '',
      status: first.status,
      changed: false,
    }
  }
  for (const candidate of candidates) {
    if (candidate.path === config.path) continue
    const next = await probe({ host: config.host, port: config.port, path: candidate.path })
    if (next.status === 401 || next.status === 200) {
      return {
        path: candidate.path,
        brand: candidate.brand || rtspBrandOf(next.realm, next.server),
        realm: next.realm ?? '',
        status: next.status,
        changed: true,
      }
    }
  }
  return {
    path: config.path,
    brand,
    realm: first.realm ?? '',
    status: first.status,
    changed: false,
  }
}

/** @type {Map<string, {config: any, lastUsed: number, auth: any, streamName?: string}>} */
const sessions = new Map()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * go2rtc 的临时配置目录。
 *
 * go2rtc 会把活动流写回配置文件，而流地址里带相机口令。优先放到 Linux 的
 * tmpfs（/dev/shm），让口令只存在内存里；没有 tmpfs 的平台再退回系统临时目录。
 * 目录权限 0700、配置 0600，进程退出时整体删除。
 */
function go2rtcTempRoot(options = {}) {
  const shm = options.shm ?? '/dev/shm'
  try {
    if (statSync(shm).isDirectory()) return shm
  } catch {
    /* 没有 /dev/shm，退回系统临时目录 */
  }
  return options.tmpdir ?? os.tmpdir()
}

/** 找一个本机空闲端口。go2rtc 只监听 127.0.0.1，不暴露到局域网。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * 按优先级找 go2rtc 可执行文件：
 * 1. `DSH_GO2RTC_BIN` 显式指定；
 * 2. `~/.dsh/tools/go2rtc/go2rtc`（本机安装位）；
 * 3. 插件目录 `bin/go2rtc`（随插件分发）；
 * 4. PATH。
 */
function resolveGo2rtcBinary(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const pluginRoot =
    options.pluginRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const candidates = []
  if (typeof env.DSH_GO2RTC_BIN === 'string' && env.DSH_GO2RTC_BIN.trim() !== '') {
    candidates.push(env.DSH_GO2RTC_BIN.trim())
  }
  candidates.push(path.join(home, '.dsh', 'tools', 'go2rtc', 'go2rtc'))
  candidates.push(path.join(pluginRoot, 'bin', 'go2rtc'))
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.push(path.join(dir, 'go2rtc'))
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* 继续找下一个 */
    }
  }
  return ''
}

/** 轮询 go2rtc 的 API，直到它真正可服务（进程退出则立刻失败）。 */
async function waitForGo2rtc(port, child, readOutput) {
  const deadline = Date.now() + GO2RTC_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`进程已退出（code ${child.exitCode}）${readOutput()}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/streams`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await delay(120)
  }
  throw new Error(`等待 API 就绪超时${readOutput()}`)
}

/**
 * go2rtc 进程管理。
 *
 * 只做一件事：把 RTSP 地址交给 go2rtc，浏览器通过同源页面里的 VideoRTC
 * 连它的 WebSocket 播放。MSE 路线不需要 ffmpeg，所以这里不依赖外部转码器。
 * 进程按需启动、空闲 60 秒退出，配置写在临时目录里（权限 0600）；
 * 相机口令只在内存和本机 API 请求里，不落盘。
 */
class Go2rtcManager {
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? GO2RTC_IDLE_MS
    this.child = null
    this.port = 0
    this.tempDir = ''
    this.streams = new Map()
    this.starting = null
    this.idleTimer = null
  }

  get running() {
    return this.child !== null && this.port !== 0
  }

  wsUrl(name) {
    /* 同源相对路径：浏览器自动补成 ws:// 或 wss://。
       宿主再用 attachCameraWebSocketProxy 转发到本机 go2rtc。
       这样浏览器和 DSH 不同机、DSH 走 HTTPS 时都能用。 */
    return `${PREFIX}/ws?src=${encodeURIComponent(name)}`
  }

  cancelIdle() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  scheduleIdle() {
    if (this.streams.size > 0 || !this.running) return
    this.cancelIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop().catch(() => {
        /* 停不掉就交给进程退出兜底 */
      })
    }, this.idleMs)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  async ensureStream(name, url) {
    const existing = this.streams.get(name)
    if (existing !== undefined) {
      existing.refs += 1
      this.cancelIdle()
      return this.wsUrl(name)
    }
    await this.ensureRunning()
    const target =
      `http://127.0.0.1:${this.port}/api/streams?name=${encodeURIComponent(name)}` +
      `&src=${encodeURIComponent(url)}`
    const response = await fetch(target, { method: 'PUT' })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(`go2rtc 添加流失败（HTTP ${response.status}）${text.slice(0, 120)}`)
    }
    /* 两个标签同时打开同一台相机时，第二个请求可能也走完了 PUT；
       这里再查一次，避免把引用计数覆盖回 1。 */
    const raced = this.streams.get(name)
    if (raced !== undefined) {
      raced.refs += 1
      this.cancelIdle()
      return this.wsUrl(name)
    }
    this.streams.set(name, { url, refs: 1 })
    this.cancelIdle()
    return this.wsUrl(name)
  }

  async removeStream(name) {
    const entry = this.streams.get(name)
    if (entry === undefined) return
    entry.refs -= 1
    if (entry.refs > 0) return
    this.streams.delete(name)
    if (this.running) {
      try {
        await fetch(
          `http://127.0.0.1:${this.port}/api/streams?src=${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        )
      } catch {
        /* 进程可能刚好退出 */
      }
    }
    this.scheduleIdle()
  }

  async ensureRunning() {
    if (this.running) return
    if (this.starting !== null) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async start() {
    const binary = resolveGo2rtcBinary()
    if (binary === '') {
      throw new Error(
        '未找到 go2rtc：设置 DSH_GO2RTC_BIN，或安装到 ~/.dsh/tools/go2rtc/go2rtc',
      )
    }
    const port = await pickFreePort()
    if (port === 0) throw new Error('找不到可用的本机端口')
    let tempDir
    try {
      tempDir = await mkdtemp(path.join(go2rtcTempRoot(), 'dsh-go2rtc-'))
    } catch {
      /* tmpfs 满 / 不可写时退回系统临时目录，仍然保持 0700 + 0600。 */
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-go2rtc-'))
    }
    const configPath = path.join(tempDir, 'go2rtc.yaml')
    const config = [
      'log:',
      '  level: warn',
      'api:',
      `  listen: "127.0.0.1:${port}"`,
      '  origin: "*"',
      'rtsp:',
      '  listen: ""',
      'webrtc:',
      '  listen: ""',
      '',
    ].join('\n')
    await writeFile(configPath, config, { mode: 0o600 })

    const child = spawn(binary, ['-config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const collect = (chunk) => {
      output = (output + String(chunk)).slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        this.port = 0
        /* 进程没了，流表也失效；否则下次 ensureStream 会拿着 port=0 的旧地址。 */
        this.streams.clear()
      }
    })
    this.child = child
    this.port = port
    this.tempDir = tempDir

    try {
      await waitForGo2rtc(port, child, () => {
        const tail = output.trim().split('\n').filter(Boolean).slice(-1)[0]
        return tail === undefined ? '' : `：${tail}`
      })
    } catch (error) {
      await this.stop()
      throw new Error(`go2rtc 启动失败：${error?.message ?? error}`)
    }
  }

  async stop() {
    this.cancelIdle()
    this.streams.clear()
    const child = this.child
    this.child = null
    this.port = 0
    const tempDir = this.tempDir
    this.tempDir = ''
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(2000),
      ]).catch(() => {})
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 进程退出兜底：同步杀子进程、删临时配置（配置里有相机口令）。 */
  killSync() {
    this.cancelIdle()
    this.streams.clear()
    if (this.child !== null) {
      try {
        this.child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      this.child = null
    }
    this.port = 0
    if (this.tempDir !== '') {
      try {
        rmSync(this.tempDir, { recursive: true, force: true })
      } catch {
        /* 删不掉就留给系统临时目录清理 */
      }
      this.tempDir = ''
    }
  }
}

const go2rtc = new Go2rtcManager()

/** go2rtc 流名格式：`cam_` + 12 位十六进制（streamNameForUrl 生成）。 */
function isCameraStreamName(value) {
  return /^cam_[0-9a-f]{12}$/.test(String(value))
}

/** 取 host 的 hostname，兼容 `host:port`、IPv6、反向代理的逗号分隔值。 */
function hostnameOf(value) {
  try {
    return new URL(`http://${String(value).split(',')[0].trim()}`).hostname
  } catch {
    return ''
  }
}

/**
 * 同源 WebSocket 代理：浏览器连 DSH 的 `/camera/ws`，宿主转发到本机 go2rtc。
 *
 * 为什么不直接把 `ws://127.0.0.1:<port>` 给浏览器：
 * - 浏览器和 DSH 不同机时，127.0.0.1 指向浏览器自己；
 * - DSH 走 HTTPS 时，明文 ws://127.0.0.1 会被混合内容策略拦截；
 * - 额外端口还要单独放行防火墙。
 *
 * 同源检查挡住跨站 WebSocket 劫持：浏览器一定带 Origin，不同源直接 403。
 */
export function cameraUpgradeHandler(manager) {
  return (req, socket, head) => {
    let url
    try {
      url = new URL(req.url ?? '', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }

    const origin = String(req.headers.origin ?? '')
    if (origin !== '') {
      const originHost = hostnameOf(origin.replace(/^https?:\/\//, ''))
      const requestHost = hostnameOf(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      if (originHost === '' || requestHost === '' || originHost !== requestHost) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
    }

    const name = String(url.searchParams.get('src') ?? '')
    if (!isCameraStreamName(name) || !manager.running) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }

    const upstream = http.request({
      host: '127.0.0.1',
      port: manager.port,
      path: `/api/ws?src=${encodeURIComponent(name)}`,
      method: 'GET',
      headers: { ...req.headers, host: `127.0.0.1:${manager.port}` },
      timeout: 5000,
    })

    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [
        `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`,
      ]
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
    })

    upstream.on('response', (response) => {
      /* go2rtc 拒绝升级（流不存在、进程刚退出）：把状态码回给浏览器。 */
      socket.end(
        `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\n` +
          'Connection: close\r\nContent-Length: 0\r\n\r\n',
      )
      response.resume()
    })
    upstream.on('timeout', () => upstream.destroy(new Error('go2rtc WebSocket 连接超时')))
    upstream.on('error', () => socket.destroy())
    upstream.end()
  }
}

/**
 * 注册到 DSH 的 upgrade 路由表。
 *
 * 不能自己监听 `server.on('upgrade')`：DSH 的 webserver 会先拿到事件，
 * 发现自己的路由表里没有这个路径就直接 destroy。必须走 registerUpgrade。
 */
export function registerCameraUpgrade(webServer, manager) {
  if (typeof webServer?.registerUpgrade !== 'function') return () => {}
  return webServer.registerUpgrade({
    path: `${PREFIX}/ws`,
    handler: cameraUpgradeHandler(manager),
  })
}

/* dsh 退出时别把 go2rtc 留成孤儿进程。 */
process.once('exit', () => go2rtc.killSync())

let sweepTimer = null

function ensureSweep() {
  if (sweepTimer !== null) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        sessions.delete(id)
        if (typeof session.streamName === 'string') {
          go2rtc.removeStream(session.streamName).catch(() => {})
        }
      }
    }
    if (sessions.size === 0) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }, SWEEP_MS)
  /* 不要因为一个相机代理把整个 dsh 进程钉住。 */
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex')
}

function randomId() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 解析 `WWW-Authenticate`。相机可能同时发 Basic 和 Digest 两个挑战，
 * Node 会把它们用逗号拼在一起，这里优先取 Digest。
 */
function parseChallenge(header) {
  const text = String(header ?? '')
  const digestIndex = text.toLowerCase().indexOf('digest ')
  if (digestIndex !== -1) {
    const params = Object.create(null)
    let body = text.slice(digestIndex + 7)
    /* Node 会把多个 WWW-Authenticate 用逗号拼起来；Digest 参数到下一个
       认证方案（Basic/Digest）为止，别把后面的 realm 覆盖进来。 */
    const nextScheme = /,\s*(?:basic|digest)\s/i.exec(body)
    if (nextScheme !== null) body = body.slice(0, nextScheme.index)
    const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g
    let match
    while ((match = re.exec(body)) !== null) {
      params[match[1].toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]
    }
    return { type: 'digest', params }
  }
  if (/^basic\b/i.test(text)) return { type: 'basic' }
  return null
}

function digestAuthorization(config, challenge, method, uri, nc) {
  const params = challenge.params
  const realm = params.realm ?? ''
  const nonce = params.nonce ?? ''
  const opaque = params.opaque
  const algorithm = (params.algorithm ?? 'MD5').toUpperCase()
  const qopOptions = String(params.qop ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const qop = qopOptions.indexOf('auth') >= 0 ? 'auth' : ''
  const cnonce = crypto.randomBytes(8).toString('hex')

  let ha1 = md5(`${config.user}:${realm}:${config.password}`)
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`)
  const ha2 = md5(`${method}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${config.user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (algorithm) parts.push(`algorithm=${algorithm}`)
  if (opaque !== undefined) parts.push(`opaque="${opaque}"`)
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  return `Digest ${parts.join(', ')}`
}

function basicAuthorization(config) {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64')}`
}

function requestUrl(config) {
  return `${config.scheme}://${config.host}:${config.port}${config.path}`
}

/**
 * 向相机发一个请求。401 时自动完成 Digest/Basic 认证后重试一次。
 *
 * @returns {Promise<{ response: import('node:http').IncomingMessage, request: import('node:http').ClientRequest }>}
 */
function requestCamera(config, session, options = {}) {
  const method = options.method ?? 'GET'
  const target = new URL(requestUrl(config))
  const uri = `${target.pathname}${target.search}`
  const transport = target.protocol === 'https:' ? https : http

  const send = (authorization) =>
    new Promise((resolve, reject) => {
      const headers = { host: target.host, accept: '*/*' }
      if (authorization !== undefined) headers.authorization = authorization
      const request = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: uri,
          method,
          headers,
          /* 相机 HTTPS 基本都是自签证书；这是内网只读取流，不校验证书。 */
          rejectUnauthorized: false,
          timeout: CONNECT_TIMEOUT_MS,
        },
        (response) => resolve({ response, request }),
      )
      request.on('timeout', () => {
        request.destroy(new Error('连接相机超时'))
      })
      request.on('error', reject)
      request.end()
    })

  return (async () => {
    const cached = session.auth
    let authorization
    if (cached?.type === 'basic') authorization = basicAuthorization(config)
    if (cached?.type === 'digest') {
      cached.nc += 1
      authorization = digestAuthorization(
        config,
        cached.challenge,
        method,
        uri,
        String(cached.nc).padStart(8, '0'),
      )
    }

    let attempt = await send(authorization)
    if (attempt.response.statusCode !== 401) return attempt

    /* 缓存的口令可能过期（stale nonce），也可能第一次就没带认证。 */
    attempt.response.resume()
    const challenge = parseChallenge(attempt.response.headers['www-authenticate'])
    if (challenge === null) return attempt

    if (challenge.type === 'basic') {
      session.auth = { type: 'basic' }
      authorization = basicAuthorization(config)
    } else {
      session.auth = { type: 'digest', challenge, nc: 1 }
      authorization = digestAuthorization(config, challenge, method, uri, '00000001')
    }
    attempt = await send(authorization)
    return attempt
  })()
}

function writeCorsHeaders(res) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate')
  res.setHeader('pragma', 'no-cache')
  res.setHeader('access-control-allow-origin', '*')
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 64 * 1024) {
        reject(new Error('请求体过大'))
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
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function normalizeConfig(input) {
  const host = String(input?.host ?? '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error('相机地址不合法')
  const modeRaw = String(input?.mode ?? 'rtsp').toLowerCase()
  const mode = modeRaw === 'mjpeg' || modeRaw === 'snapshot' ? modeRaw : 'rtsp'
  const port = Number(input?.port ?? (mode === 'rtsp' ? 554 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('相机端口不合法')
  const scheme = String(input?.scheme ?? 'http').toLowerCase() === 'https' ? 'https' : 'http'
  let path = String(input?.path ?? '').trim()
  if (path === '' && mode === 'rtsp') path = RTSP_DEFAULT_PATH
  if (!path.startsWith('/') || /[\r\n]/.test(path)) throw new Error('流路径要以 / 开头')
  /* 快照接口单独给一个字段：MJPEG 流地址不能拿来取单帧。
     Axis 的惯例路径可以直接推导，其它品牌由书签里显式填写。 */
  let snapshotPath = String(input?.snapshotPath ?? '').trim()
  if (snapshotPath === '') {
    snapshotPath = /axis-cgi\/mjpg\/video\.cgi/.test(path) ? '/axis-cgi/jpg/image.cgi' : path
  }
  if (!snapshotPath.startsWith('/') || /[\r\n]/.test(snapshotPath)) throw new Error('快照路径要以 / 开头')
  const config = {
    host,
    port,
    scheme,
    user: String(input?.user ?? ''),
    password: String(input?.password ?? ''),
    path,
    snapshotPath,
    mode,
  }
  if (mode === 'rtsp') config.rtspUrl = buildRtspUrl(config)
  return config
}

/**
 * 拼 RTSP 地址。
 *
 * 账号和口令必须百分号编码：相机口令经常带 `@`、`!` 这类字符，
 * 不编码会被 URL 解析成主机名的一部分（go2rtc 就会连错地址）。
 */
function buildRtspUrl(config) {
  const auth =
    config.user === ''
      ? ''
      : `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
  return `rtsp://${auth}${config.host}:${config.port}${config.path}`
}

/** 把一张 JPEG 包成 multipart 帧。 */
function writeFrame(res, buffer) {
  res.write(`--${BOUNDARY}\r\n`)
  res.write('Content-Type: image/jpeg\r\n')
  res.write(`Content-Length: ${buffer.length}\r\n\r\n`)
  res.write(buffer)
  res.write('\r\n')
}

/** 读完整响应体（快照用），带大小上限。 */
function readBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    response.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_FRAME_BYTES) {
        response.destroy(new Error('相机帧过大'))
        reject(new Error('相机帧过大'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(chunks)))
    response.on('error', reject)
  })
}

/** 取一张 JPEG。 */
async function fetchSnapshot(config, session) {
  const target = { ...config, path: config.snapshotPath || config.path }
  const { response, request } = await requestCamera(target, session)
  if (response.statusCode !== 200) {
    response.resume()
    request.destroy()
    throw new Error(`相机返回 HTTP ${response.statusCode}`)
  }
  const type = String(response.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('image/')) {
    response.resume()
    request.destroy()
    throw new Error(`相机返回的不是图片（${type || '未知类型'}）`)
  }
  return readBody(response)
}

/** 把快照轮询包装成浏览器可看的 MJPEG。 */
async function streamSnapshots(config, session, req, res) {
  writeCorsHeaders(res)
  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    connection: 'keep-alive',
  })

  let stopped = false
  const stop = () => {
    stopped = true
  }
  /* 只监听响应关闭：GET 的 req 在请求体读完后就会触发 close，
     拿它当“浏览器断开”会立刻把流掐掉。 */
  res.on('close', stop)

  while (!stopped) {
    const started = Date.now()
    try {
      const frame = await fetchSnapshot(config, session)
      if (stopped) break
      writeFrame(res, frame)
    } catch (error) {
      if (stopped) break
      /* 单帧失败不终止整条流：相机偶尔丢一帧很常见，下一轮继续。 */
      res.write(`--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\n${String(error?.message ?? error)}\r\n`)
    }
    const wait = Math.max(0, SNAPSHOT_INTERVAL_MS - (Date.now() - started))
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  try {
    res.end()
  } catch {
    /* 已经断开 */
  }
}

/** 直接转发相机的 MJPEG。 */
async function streamMjpeg(config, session, req, res) {
  const { response, request } = await requestCamera(config, session)
  const status = response.statusCode ?? 0
  if (status !== 200) {
    response.resume()
    request.destroy()
    throw new Error(`相机返回 HTTP ${status}`)
  }
  const type = String(response.headers['content-type'] ?? '').toLowerCase()

  if (type.startsWith('multipart/x-mixed-replace')) {
    writeCorsHeaders(res)
    res.writeHead(200, { 'content-type': response.headers['content-type'] })
    response.pipe(res)
    const stop = () => {
      response.destroy()
      request.destroy()
    }
    res.on('close', stop)
    return
  }

  /* 有些相机的“流地址”其实返回单张 JPEG：退化成快照轮询。 */
  response.resume()
  request.destroy()
  await streamSnapshots(config, session, req, res)
}

/**
 * 注册相机路由。
 *
 * @param {any} webCtx 含 webServer 的上下文
 */
export function registerCameraApi(webCtx) {
  const route = (method, path, handler) =>
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path,
          handler(req, res) {
            if (req.method !== method) {
              sendJson(res, 405, { ok: false, error: `只支持 ${method}` })
              return
            }
            Promise.resolve(handler(req, res)).catch((error) => {
              console.error('[terminal-workbench] camera proxy error:', error?.message ?? error)
              if (res.headersSent) {
                try {
                  res.destroy()
                } catch {
                  /* 已断开 */
                }
                return
              }
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            })
          },
        }),
      `terminal-workbench: camera ${method} ${path}`,
    )

  /* 探测相机品牌 / 流路径：不带口令，只读 DESCRIBE 状态码。
     相机表单的「自动识别品牌」用它；建立会话时也用它兜底纠正常见路径错误。 */
  route('POST', `${PREFIX}/probe`, async (req, res) => {
    try {
      const body = await readJson(req)
      const config = normalizeConfig({ ...body, mode: 'rtsp', user: '', password: '' })
      const detected = await detectRtspPath(config)
      sendJson(res, 200, { ok: true, ...detected })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  /* 找 H.264 码流：带认证读 SDP，只在同一品牌内换 profile。
     口令只在请求体里；响应只回路径和编码，不回账号口令。 */
  route('POST', `${PREFIX}/codec`, async (req, res) => {
    try {
      const body = await readJson(req)
      const config = normalizeConfig({ ...body, mode: 'rtsp' })
      const result = await detectH264Path(config)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  /* 建立会话：口令只在请求体里，不进入 URL。 */
  route('POST', `${PREFIX}/session`, async (req, res) => {
    const body = await readJson(req)
    let config = normalizeConfig(body)
    /* 内置默认路径才自动纠正：韩华相机配安讯士路径会 404，
       go2rtc 报 `wrong response on DESCRIBE`。用户手填的路径不碰。 */
    let detected
    if (config.mode === 'rtsp' && isBuiltinRtspPath(config.path)) {
      detected = await detectRtspPath(config)
      if (detected.changed) config = normalizeConfig({ ...body, path: detected.path })
    }
    /* 浏览器 MSE 只稳定支持 H.264；路径能连通时先读 SDP，若当前是 H.265
       就自动换到同品牌 H.264 profile。探测失败不挡播放，交给播放器报错。 */
    let codec = ''
    let originalPath = ''
    if (
      config.mode === 'rtsp' &&
      needsCodecCheck(config.path) &&
      config.user !== '' &&
      config.password !== '' &&
      (detected === undefined || detected.status !== 0)
    ) {
      try {
        const codecInfo = await detectH264Path(config)
        codec = codecInfo.codec ?? ''
        if (codecInfo.changed) {
          originalPath = config.path
          config = normalizeConfig({ ...body, path: codecInfo.path })
        }
      } catch {
        /* 编码探测是增强项，失败不影响正常取流 */
      }
    }
    const id = randomId()
    if (config.mode === 'rtsp') {
      /* 流名跟着 RTSP 地址走：同一台相机多开标签共享一条流，引用计数归零才删。 */
      const streamName = streamNameForUrl(config.rtspUrl)
      const wsUrl = await go2rtc.ensureStream(streamName, config.rtspUrl)
      sessions.set(id, { config, lastUsed: Date.now(), auth: null, streamName })
      ensureSweep()
      sendJson(res, 200, {
        ok: true,
        id,
        mode: 'rtsp',
        wsUrl,
        path: config.path,
        brand: detected === undefined ? '' : detected.brand,
        detected: detected !== undefined && detected.changed,
        codec,
        originalPath,
        codecChanged: originalPath !== '',
      })
      return
    }
    sessions.set(id, { config, lastUsed: Date.now(), auth: null })
    ensureSweep()
    sendJson(res, 200, { ok: true, id, mode: config.mode })
  })

  /* go2rtc 播放器（VideoRTC，MIT）：同源加载，浏览器里动态 import。 */
  route('GET', `${PREFIX}/player.js`, async (req, res) => {
    const asset = await getPlayerAsset()
    const requestUrl = new URL(req.url, 'http://localhost')
    /* 带 ?v=<构建号> 的地址视为不可变，允许浏览器长期缓存；旧地址保持 no-cache。 */
    const versioned = (requestUrl.searchParams.get('v') ?? '') !== ''
    const headers = {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: asset.etag,
      'x-content-type-options': 'nosniff',
      vary: 'accept-encoding',
    }
    const ifNoneMatch = String(req.headers['if-none-match'] ?? '')
    if (ifNoneMatch.split(',').map((value) => value.trim()).includes(asset.etag)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip' })
      res.end(asset.gzip)
      return
    }
    res.writeHead(200, headers)
    res.end(asset.source)
  })

  /* MJPEG / 快照轮询（兼容模式）。 */
  route('GET', `${PREFIX}/stream`, async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const id = String(url.searchParams.get('id') ?? '')
    const session = sessions.get(id)
    if (session === undefined) {
      sendJson(res, 404, { ok: false, error: '相机会话已过期，请重载' })
      return
    }
    session.lastUsed = Date.now()
    if (session.config.mode === 'rtsp') {
      sendJson(res, 400, { ok: false, error: 'RTSP 模式请用 WebSocket 播放器取流' })
      return
    }
    if (session.config.mode === 'snapshot') {
      await streamSnapshots(session.config, session, req, res)
    } else {
      await streamMjpeg(session.config, session, req, res)
    }
  })

  /* 单张快照：用于“测试参数”或流失败时的静态兜底。 */
  route('GET', `${PREFIX}/snapshot`, async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const id = String(url.searchParams.get('id') ?? '')
    const session = sessions.get(id)
    if (session === undefined) {
      sendJson(res, 404, { ok: false, error: '相机会话已过期，请重载' })
      return
    }
    session.lastUsed = Date.now()
    if (session.config.mode === 'rtsp') {
      sendJson(res, 501, { ok: false, error: 'RTSP 模式请从播放器画面截图' })
      return
    }
    const frame = await fetchSnapshot(session.config, session)
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store',
      'content-length': frame.length,
    })
    res.end(frame)
  })

  /* 关闭会话（标签关闭时调用，及时释放相机连接）。 */
  route('POST', `${PREFIX}/close`, async (req, res) => {
    const body = await readJson(req)
    const id = String(body?.id ?? '')
    if (id !== '') {
      const session = sessions.get(id)
      sessions.delete(id)
      if (session !== undefined && typeof session.streamName === 'string') {
        await go2rtc.removeStream(session.streamName).catch(() => {})
      }
    }
    sendJson(res, 200, { ok: true })
  })

  /* 同源 WebSocket 代理：走 DSH 的 registerUpgrade 路由表。
     测试 / 旧版 webServer 没有 registerUpgrade 时自动跳过。 */
  webCtx.effect(
    () => registerCameraUpgrade(webCtx.webServer, go2rtc),
    'terminal-workbench: camera websocket proxy',
  )

  /* 插件卸载/热重载时把 go2rtc 一起收掉。 */
  webCtx.effect(() => () => {
    go2rtc.stop().catch(() => {})
  })
}

/** 测试用：暴露内部函数，避免测试去重复实现 Digest 计算。 */
export const __test = {
  parseChallenge,
  digestAuthorization,
  normalizeConfig,
  buildRtspUrl,
  resolveGo2rtcBinary,
  requestUrl,
  requestCamera,
  sessions,
  go2rtc,
  Go2rtcManager,
  streamNameForUrl,
  probeRtspDescribe,
  detectRtspPath,
  probeRtspCodec,
  detectH264Path,
  parseSdpVideoCodecs,
  clearCodecCache,
  needsCodecCheck,
  isBuiltinRtspPath,
  rtspBrandOf,
  setRtspProbeImpl,
  setRtspCodecProbeImpl,
  RTSP_PATH_CANDIDATES,
  RTSP_H264_FALLBACKS,
  HANWHA_PROFILE_PATHS,
  getPlayerAsset,
  go2rtcTempRoot,
}
