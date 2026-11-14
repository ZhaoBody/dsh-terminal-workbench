/**
 * dsh-terminal-workbench — SSH 隧道管理器（v0.8.0）。
 *
 * 为什么不复用 `remote-fs` 的连接池：连接池的目标是 SFTP，建完通道就撒手；
 * 隧道要长期持有 client、监听本地端口、挂 `tcp connection` 事件。两者生命周期
 * 完全不同。本模块以「链路（chain）」为单位管理：
 *
 *   chain = [bastion, ..., target]
 *
 * 跳板串联用上一跳的 `forwardOut` 建流，再 `Client.connect({ sock })`，
 * 语义等价于 `ssh -J bastion target`。末跳挂真正的转发：
 *   - `L` 本地端口 → 远端目标
 *   - `R` 远端端口 → 本地目标
 *   - `D` 本地 SOCKS5（只实现 CONNECT + 无认证）
 *
 * 清理铁律：`close` / 连接 `error` / `process exit` 三条路径都必须释放监听端口；
 * 部分失败要回收已经建好的端口和 client，不能留下半条链。
 *
 * @module dsh-terminal-workbench/forward
 */

import net from 'node:net'
import { readKey, readRemotes } from './remote-fs.js'

/** 单次最多同时存在的转发条数。 */
export const MAX_FORWARDS = 8

/** 跳板链最多 4 跳（含目标）。 */
export const MAX_CHAIN = 4

const READY_TIMEOUT_MS = 15000
const CONNECT_TIMEOUT_MS = 15000

function forwardError(message, code = 'FORWARD_ERROR', cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function normalizeType(raw) {
  const value = String(raw ?? 'L').trim().toUpperCase()
  if (value === 'LOCAL' || value === 'L') return 'L'
  if (value === 'REMOTE' || value === 'R') return 'R'
  if (value === 'SOCKS' || value === 'DYNAMIC' || value === 'D') return 'D'
  throw forwardError(`不支持的转发类型「${raw}」，只支持 L / R / D`, 'FORWARD_INVALID')
}

function parsePort(raw, label) {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) throw forwardError(`${label}不是合法端口：${raw}`, 'FORWARD_INVALID')
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw forwardError(`${label}超出 0-65535：${raw}`, 'FORWARD_INVALID')
  }
  return value
}

/**
 * 解析 `host:port` / `[ipv6]:port` / 裸 `port`。
 * @param {string} raw
 * @param {number} fallbackPort 没有冒号时使用；传 undefined 表示必须写端口
 */
function splitHostPort(raw, fallbackPort, label) {
  const text = String(raw ?? '').trim()
  if (text === '') throw forwardError(`${label}不能为空`, 'FORWARD_INVALID')
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(text)
  if (bracketed !== null) {
    const host = bracketed[1]
    const port = bracketed[2] === undefined ? fallbackPort : parsePort(bracketed[2], label)
    if (port === undefined) throw forwardError(`${label}缺少端口：${raw}`, 'FORWARD_INVALID')
    return { host, port }
  }
  const colon = text.lastIndexOf(':')
  if (colon === -1) {
    if (fallbackPort === undefined) throw forwardError(`${label}缺少端口：${raw}`, 'FORWARD_INVALID')
    return { host: text, port: fallbackPort }
  }
  const host = text.slice(0, colon)
  const portText = text.slice(colon + 1)
  if (host === '') throw forwardError(`${label}缺少主机：${raw}`, 'FORWARD_INVALID')
  /* 未加方括号的 IPv6 会被这里拒绝：提示用户写 [::1]:22，避免悄悄按最后一个冒号切错。 */
  if (host.includes(':')) {
    throw forwardError(`${label}的 IPv6 地址要加方括号，例如 [::1]:22：${raw}`, 'FORWARD_INVALID')
  }
  return { host, port: parsePort(portText, label) }
}

function parseBind(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { host: '127.0.0.1', port: 0 }
  }
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return { host: '127.0.0.1', port: parsePort(text, '监听端口') }
  const parsed = splitHostPort(text, undefined, '监听地址')
  return {
    host: parsed.host === '*' ? '0.0.0.0' : parsed.host,
    port: parsed.port,
  }
}

function parseDestination(raw) {
  return splitHostPort(raw, undefined, '目标地址')
}

/**
 * 解析一条转发规格。支持：
 *   - 对象：`{ type:'L', bind:'127.0.0.1:8080', dest:'db:5432' }`
 *   - 字符串：`L 8080:db:5432` / `-L 127.0.0.1:8080:db:5432` / `D 1080`
 *
 * @param {any} input
 * @returns {{type:'L'|'R'|'D', bindHost:string, bindPort:number, destHost?:string, destPort?:number, text:string}}
 */
export function parseForward(input) {
  if (input !== null && typeof input === 'object') {
    const type = normalizeType(input.type)
    const bind = parseBind(input.bind ?? input.bindHost ?? input.listen)
    if (type === 'D') {
      return { type, bindHost: bind.host, bindPort: bind.port, text: `D ${bind.host}:${bind.port}` }
    }
    const destRaw =
      input.dest ??
      (input.destHost !== undefined && input.destPort !== undefined
        ? `${input.destHost}:${input.destPort}`
        : undefined)
    const dest = parseDestination(destRaw)
    return {
      type,
      bindHost: bind.host,
      bindPort: bind.port,
      destHost: dest.host,
      destPort: dest.port,
      text: `${type} ${bind.host}:${bind.port}:${dest.host}:${dest.port}`,
    }
  }

  const raw = String(input ?? '').trim()
  if (raw === '') throw forwardError('转发规格不能为空', 'FORWARD_INVALID')
  const flagged = /^-?([LRD])\s+(.+)$/iu.exec(raw)
  const type = normalizeType(flagged === null ? 'L' : flagged[1])
  const body = (flagged === null ? raw : flagged[2]).trim()
  if (body === '') throw forwardError(`转发规格缺少参数：${raw}`, 'FORWARD_INVALID')

  const words = body.split(/\s+/u)
  if (words.length === 1) {
    if (type === 'D') {
      const bind = parseBind(words[0])
      return { type, bindHost: bind.host, bindPort: bind.port, text: `D ${bind.host}:${bind.port}` }
    }
    /* 从右往左切：最后两段一定是目标 host:port，前面全是 bind。
       这样 `127.0.0.1:8080:db:5432` 不会被误切成 bind=127.0.0.1 / dest=8080:db。 */
    const match = /^(.*):(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(body)
    if (match === null) {
      throw forwardError(`转发规格要写成 bind:host:port，例如 L 8080:db:5432：${raw}`, 'FORWARD_INVALID')
    }
    const bind = parseBind(match[1])
    return {
      type,
      bindHost: bind.host,
      bindPort: bind.port,
      destHost: match[2].replace(/^\[|\]$/gu, ''),
      destPort: parsePort(match[3], '目标端口'),
      text: `${type} ${bind.host}:${bind.port}:${match[2]}:${match[3]}`,
    }
  }
  if (words.length === 2 && type !== 'D') {
    const bind = parseBind(words[0])
    const dest = parseDestination(words[1])
    return {
      type,
      bindHost: bind.host,
      bindPort: bind.port,
      destHost: dest.host,
      destPort: dest.port,
      text: `${type} ${bind.host}:${bind.port}:${dest.host}:${dest.port}`,
    }
  }
  throw forwardError(
    type === 'D' ? `D 只接受一个监听地址：${raw}` : `转发规格参数过多：${raw}`,
    'FORWARD_INVALID',
  )
}

/**
 * 从 remotes.json 解析跳板链：`entry.jumpHost`（或 jump）引用另一个别名。
 * 返回顺序为「最外层跳板 → 目标」。
 *
 * @param {Record<string, any>} remotes
 * @param {string} alias
 * @returns {string[]}
 */
export function resolveChain(remotes, alias) {
  const target = String(alias ?? '').trim()
  if (target === '') throw forwardError('alias 不能为空', 'FORWARD_INVALID')
  const chain = []
  const seen = new Set()
  let current = target
  while (current !== undefined) {
    if (seen.has(current)) {
      throw forwardError(`跳板链存在循环：${[...chain, current].join(' → ')}`, 'FORWARD_CYCLE')
    }
    const entry = remotes[current]
    if (entry === undefined) {
      const known = Object.keys(remotes)
      throw forwardError(
        known.length === 0
          ? `远端「${current}」未配置：remotes.json 里还没有任何远端`
          : `远端「${current}」未配置，已配置：${known.join('、')}`,
        'FORWARD_NOT_FOUND',
      )
    }
    seen.add(current)
    chain.unshift(current)
    if (chain.length > MAX_CHAIN) {
      throw forwardError(`跳板链超过 ${MAX_CHAIN} 跳：${chain.join(' → ')}`, 'FORWARD_CHAIN_TOO_LONG')
    }
    const next = entry.jumpHost ?? entry.jump ?? entry.proxyJump
    current = typeof next === 'string' && next.trim() !== '' ? next.trim() : undefined
    if (current !== undefined && remotes[current] === undefined) {
      throw forwardError(
        `跳板「${current}」未在 remotes.json 中配置；当前只支持引用另一个别名，不支持内联 user@host`,
        'FORWARD_NOT_FOUND',
      )
    }
  }
  return chain
}

async function loadClientClass() {
  const mod = await import('ssh2')
  const Client = mod.Client ?? mod.default?.Client
  if (typeof Client !== 'function') throw forwardError('ssh2 没有导出 Client', 'FORWARD_IO')
  return Client
}

function connectHop(Client, alias, entry, sock) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        client.destroy()
      } catch {
        /* 忽略 */
      }
      reject(forwardError(`SSH 握手超时（${alias} ${entry.username}@${entry.host}）`, 'FORWARD_TIMEOUT'))
    }, READY_TIMEOUT_MS)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve(client)
      else {
        try {
          client.destroy()
        } catch {
          /* 忽略 */
        }
        reject(
          forwardError(
            `SSH 连接失败（${alias} ${entry.username}@${entry.host}）：${error?.message ?? error}`,
            'FORWARD_IO',
            error,
          ),
        )
      }
    }
    client.once('ready', () => finish())
    client.once('error', finish)
    const config = {
      username: entry.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      ...(entry.auth === 'password' ? { password: entry.password } : { privateKey: readKey(entry) }),
      ...(typeof entry.passphrase === 'string' && entry.passphrase !== '' ? { passphrase: entry.passphrase } : {}),
    }
    if (sock === undefined) {
      config.host = entry.host
      config.port = entry.port ?? 22
    } else {
      config.sock = sock
    }
    try {
      client.connect(config)
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * 建立整条链。返回的 `target` 是末跳 client，所有转发都挂在它上面。
 * 失败时回收已建 client，调用方不需要再清理。
 */
async function openChain(remotes, chain) {
  const Client = await loadClientClass()
  const clients = []
  let sock
  try {
    for (let index = 0; index < chain.length; index += 1) {
      const alias = chain[index]
      const entry = remotes[alias]
      const client = await connectHop(Client, alias, entry, sock)
      clients.push(client)
      const nextAlias = chain[index + 1]
      if (nextAlias !== undefined) {
        const next = remotes[nextAlias]
        sock = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(forwardError(`建立跳板通道超时（${alias} → ${nextAlias}）`, 'FORWARD_TIMEOUT')),
            CONNECT_TIMEOUT_MS,
          )
          client.forwardOut('127.0.0.1', 0, next.host, next.port ?? 22, (error, stream) => {
            clearTimeout(timer)
            if (error) {
              reject(
                forwardError(
                  `跳板 ${alias} 无法连接 ${nextAlias}（${next.host}:${next.port ?? 22}）：${error?.message ?? error}`,
                  'FORWARD_IO',
                  error,
                ),
              )
            } else resolve(stream)
          })
        })
      }
    }
    return { clients, target: clients[clients.length - 1] }
  } catch (error) {
    for (const client of clients.reverse()) {
      try {
        client.end()
      } catch {
        /* 忽略 */
      }
    }
    throw error
  }
}

/** 双向桥接，任一端关闭/出错都销毁另一端，避免半开 socket 泄漏。 */
function bridge(left, right, record) {
  record.sockets.add(left)
  record.sockets.add(right)
  const destroy = () => {
    try {
      left.destroy()
    } catch {
      /* 忽略 */
    }
    try {
      right.destroy()
    } catch {
      /* 忽略 */
    }
    record.sockets.delete(left)
    record.sockets.delete(right)
  }
  left.on('error', destroy)
  right.on('error', destroy)
  left.on('close', () => {
    record.sockets.delete(left)
    try {
      right.destroy()
    } catch {
      /* 忽略 */
    }
  })
  right.on('close', () => {
    record.sockets.delete(right)
    try {
      left.destroy()
    } catch {
      /* 忽略 */
    }
  })
  left.pipe(right)
  right.pipe(left)
}

/** 本地监听服务器：端口 0 时返回 OS 分配的实际端口。 */
function listenServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(
        forwardError(
          `监听 ${host}:${port} 失败${error?.code === 'EADDRINUSE' ? '（端口已被占用）' : ''}：${error?.message ?? error}`,
          'FORWARD_BIND',
          error,
        ),
      )
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address()?.port ?? port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (error) {
      onError(error)
    }
  })
}

/** SOCKS5：只接受无认证 + CONNECT，其他命令明确拒绝。 */
function handleSocks(socket, record, target) {
  let buffer = Buffer.alloc(0)
  let phase = 'greeting'
  const fail = (code) => {
    try {
      socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
    } catch {
      /* 忽略 */
    }
  }

  /* 握手与请求可能落在同一个 TCP 包里（客户端 pipelining），
     所以每次处理完一个阶段都要**立刻回看 buffer**，不能等下一次 data 事件。 */
  const pump = () => {
    for (;;) {
      if (phase === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 5) {
          socket.destroy()
          return
        }
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        if (!methods.includes(0)) {
          socket.end(Buffer.from([5, 0xff]))
          return
        }
        socket.write(Buffer.from([5, 0]))
        buffer = buffer.subarray(2 + count)
        phase = 'request'
        continue
      }
      if (buffer.length < 4) return
      if (buffer[0] !== 5 || buffer[1] !== 1) {
        fail(7)
        return
      }
      const atyp = buffer[3]
      let offset = 4
      let host
      if (atyp === 1) {
        if (buffer.length < offset + 4 + 2) return
        host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`
        offset += 4
      } else if (atyp === 3) {
        if (buffer.length < offset + 1) return
        const length = buffer[offset]
        offset += 1
        if (buffer.length < offset + length + 2) return
        host = buffer.subarray(offset, offset + length).toString('utf8')
        offset += length
      } else if (atyp === 4) {
        if (buffer.length < offset + 16 + 2) return
        const parts = []
        for (let i = 0; i < 8; i += 1) parts.push(buffer.readUInt16BE(offset + i * 2).toString(16))
        host = parts.join(':')
        offset += 16
      } else {
        fail(8)
        return
      }
      const port = buffer.readUInt16BE(offset)
      const rest = buffer.subarray(offset + 2)
      socket.off('data', onData)
      target.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) {
          fail(5)
          return
        }
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        bridge(socket, stream, record)
        /* CONNECT 成功前客户端可能已经推了应用层数据；不能丢。 */
        if (rest.length > 0) stream.write(rest)
      })
      return
    }
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    pump()
  }
  socket.on('data', onData)
}

export class ForwardManager {
  constructor(remotesFile) {
    this.remotesFile = remotesFile
    /** @type {Map<string, any>} */
    this.records = new Map()
    this.nextId = 1
    this.disposed = false
    this.onExit = () => this.dispose()
    process.once('exit', this.onExit)
  }

  /** 当前生效的转发摘要（不含 client 等内部对象）。 */
  list() {
    return [...this.records.values()].map((record) => this.summary(record))
  }

  summary(record) {
    const port = record.type === 'R' ? record.remotePort : record.localPort
    const bind =
      record.type === 'R'
        ? `${record.bindHost}:${port ?? record.bindPort}`
        : `${record.bindHost}:${port ?? record.bindPort}`
    return {
      id: record.id,
      type: record.type,
      alias: record.alias,
      chain: record.chain.join(' → '),
      bind,
      dest: record.type === 'D' ? 'SOCKS5 / CONNECT' : `${record.destHost}:${record.destPort}`,
      port: port ?? record.bindPort,
      createdAt: record.createdAt,
    }
  }

  /**
   * 开一条转发。
   * @param {{alias:string,type?:string,bind?:string,dest?:string,chain?:string[]}} options
   */
  async open(options) {
    if (this.disposed) throw forwardError('隧道管理器已卸载', 'FORWARD_DISPOSED')
    if (this.records.size >= MAX_FORWARDS) {
      throw forwardError(`同时最多 ${MAX_FORWARDS} 条转发，请先 forward_close 不再需要的隧道`, 'FORWARD_LIMIT')
    }
    const alias = String(options?.alias ?? '').trim()
    if (alias === '') throw forwardError('alias 不能为空', 'FORWARD_INVALID')
    const type = normalizeType(options?.type)
    const bind = parseBind(options?.bind)
    let destHost
    let destPort
    if (type !== 'D') {
      const dest = parseDestination(options?.dest)
      destHost = dest.host
      destPort = dest.port
    }
    const remotes = readRemotes(this.remotesFile)
    const chain =
      Array.isArray(options?.chain) && options.chain.length > 0
        ? options.chain.map((item) => String(item))
        : resolveChain(remotes, alias)
    if (chain[chain.length - 1] !== alias) {
      throw forwardError(`chain 的最后一跳必须是目标 alias「${alias}」`, 'FORWARD_INVALID')
    }
    for (const hop of chain) {
      if (remotes[hop] === undefined) throw forwardError(`跳板「${hop}」未在 remotes.json 中配置`, 'FORWARD_NOT_FOUND')
    }
    if (chain.length > MAX_CHAIN) throw forwardError(`跳板链超过 ${MAX_CHAIN} 跳`, 'FORWARD_CHAIN_TOO_LONG')

    const link = await openChain(remotes, chain)
    const id = `fwd-${this.nextId++}`
    const record = {
      id,
      type,
      alias,
      chain,
      bindHost: bind.host,
      bindPort: bind.port,
      destHost,
      destPort,
      localPort: undefined,
      remotePort: undefined,
      createdAt: Date.now(),
      clients: link.clients,
      target: link.target,
      server: undefined,
      remoteHandler: undefined,
      sockets: new Set(),
      closed: false,
    }

    const cleanupOnDeath = () => {
      if (record.closed) return
      console.warn(`[terminal-workbench] SSH 链路已断开，自动回收转发 ${id}`)
      this.close(id).catch(() => {})
    }
    for (const client of link.clients) client.once('close', cleanupOnDeath)

    try {
      if (type === 'L') {
        record.server = net.createServer((socket) => {
          record.sockets.add(socket)
          socket.on('close', () => record.sockets.delete(socket))
          link.target.forwardOut('127.0.0.1', 0, destHost, destPort, (error, stream) => {
            if (error) {
              socket.destroy()
              return
            }
            bridge(socket, stream, record)
          })
        })
        record.localPort = await listenServer(record.server, bind.host, bind.port)
        record.server.on('error', (error) => {
          console.warn(`[terminal-workbench] 转发 ${id} 监听错误：`, error?.message ?? error)
        })
      } else if (type === 'D') {
        record.server = net.createServer((socket) => {
          record.sockets.add(socket)
          socket.on('close', () => record.sockets.delete(socket))
          handleSocks(socket, record, link.target)
        })
        record.localPort = await listenServer(record.server, bind.host, bind.port)
        record.server.on('error', (error) => {
          console.warn(`[terminal-workbench] SOCKS 转发 ${id} 监听错误：`, error?.message ?? error)
        })
      } else {
        record.remoteHandler = (info, accept, reject) => {
          if (record.remotePort !== undefined && info.destPort !== record.remotePort) return reject()
          let stream
          try {
            stream = accept()
          } catch {
            return
          }
          const local = net.connect(destPort, destHost)
          local.on('error', () => {
            stream.destroy()
            local.destroy()
          })
          bridge(stream, local, record)
        }
        link.target.on('tcp connection', record.remoteHandler)
        record.remotePort = await new Promise((resolve, reject) => {
          link.target.forwardIn(bind.host, bind.port, (error, port) => {
            if (error) {
              reject(
                forwardError(
                  `远端监听 ${bind.host}:${bind.port} 失败（可能被服务端 GatewayPorts 限制）：${error?.message ?? error}`,
                  'FORWARD_BIND',
                  error,
                ),
              )
            } else resolve(port)
          })
        })
      }
    } catch (error) {
      this.cleanup(record)
      throw error
    }

    this.records.set(id, record)
    console.log(
      `[terminal-workbench] 转发 ${id} 已建立：${type} ${record.bindHost}:${
        type === 'R' ? record.remotePort : record.localPort
      } → ${type === 'D' ? 'SOCKS5' : `${destHost}:${destPort}`}（链路 ${chain.join(' → ')}）`,
    )
    return this.summary(record)
  }

  /** 关闭一条转发；不存在时抛错，方便模型区分“已经关了”和“参数写错”。 */
  async close(id) {
    const key = String(id ?? '').trim()
    const record = this.records.get(key)
    if (record === undefined) throw forwardError(`没有这条转发：${id}`, 'FORWARD_NOT_FOUND')
    this.records.delete(key)
    this.cleanup(record)
    console.log(`[terminal-workbench] 转发 ${key} 已关闭`)
    return { id: key, closed: true }
  }

  /** 同步清理：close / error / process exit 共用，重复调用安全。 */
  cleanup(record) {
    if (record.closed === true) return
    record.closed = true
    if (record.server !== undefined) {
      try {
        record.server.close()
      } catch {
        /* 忽略 */
      }
      record.server = undefined
    }
    if (record.type === 'R' && record.target !== undefined) {
      try {
        record.target.removeListener('tcp connection', record.remoteHandler)
      } catch {
        /* 忽略 */
      }
      try {
        record.target.unforwardIn(record.bindHost, record.remotePort ?? record.bindPort, () => {})
      } catch {
        /* 忽略 */
      }
    }
    for (const socket of record.sockets) {
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
    }
    record.sockets.clear()
    for (const client of [...record.clients].reverse()) {
      try {
        client.end()
      } catch {
        /* 忽略 */
      }
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    process.removeListener('exit', this.onExit)
    for (const record of [...this.records.values()]) this.cleanup(record)
    this.records.clear()
  }
}
