/**
 * dsh-terminal-workbench — 远端文件后端（v0.6.0，SFTP over ssh2）。
 *
 * 目标：让模型的 read/write/edit/list 等文件工具能指向 SSH 远端，
 * 路径写法 `remote:别名:/绝对/路径`，与本地路径并存。
 *
 * 架构约束（勘察结论）：
 * - Cordis 的服务槽是**单注册**：`provide('fs')` 重复注册直接抛错，
 *   `set` 也只能由原 fiber 调——插件无法接管 `ctx.fs` 槽位。
 * - 但消费方（dsh-tool-fs）每次 execute 都动态调 `ctx.fs.resolve/...`，
 *   所以本模块**包装（monkey-patch）现有 ctx.fs 实例的方法**做路由：
 *   命中 `remote:` 前缀（path 形参）或 `remote+别名://` 前缀（targetKey）
 *   的请求转给 RemoteBackend，其余原样透传给原本地后端。
 * - FsTargetKey / FsVersion 是 branded opaque 字符串，后端自定格式合法
 *   （"consumers MUST NOT parse it"），远端用 `remote+别名://realpath`。
 *
 * 远端清单放在宿主侧 `<profile>/.dsh-terminal-workbench/remotes.json`：
 * ```json
 * {
 *   "vps":  { "host": "1.2.3.4", "port": 22, "username": "root",
 *             "auth": "key", "keyPath": "~/.ssh/id_rsa" },
 *   "prod": { "host": "example.com", "username": "deploy",
 *             "auth": "password", "password": "…" }
 * }
 * ```
 * 改文件即时生效（每次用前重读），连接按别名懒建立、断线自动重连。
 *
 * @module dsh-terminal-workbench/remote-fs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** path 形参上的远端前缀：`remote:别名:/远端/路径`。
 *  别名允许中文、`+`、空格等书签名常见字符，只排除 `:` 与 `/`——
 *  它们会和 `remote:` 语法本身打架。 */
const PATH_RE = /^remote:([^:/]+):(\/.*)$/
/** targetKey 上的远端前缀（backend resolve 产出，opaque 合法格式）。 */
const KEY_PREFIX = 'remote+'
const KEY_RE = /^remote\+([^:/]+):\/\/(.*)$/

/** 单文件读上限（与本地后端同量级，防止 SFTP 全量缓冲爆内存）。 */
const MAX_READ_BYTES = 64 * 1024 * 1024

/**
 * 造一个带 code 的错误。dsh-fs 的 FsError 在插件依赖树里不可达，
 * 而消费方只读 `error.code` 分支，所以用普通 Error + code 即可。
 */
function fsError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

/**
 * 归一化远端 POSIX 路径：折叠 `//`、`.`、`..`，不解析符号链接。
 *
 * 为什么要在入口做：SFTP 服务端把 `/a//b` 与 `/a/b` 当成两个字符串；
 * `stat` 说没有、`readdir` 却能列出来，是文件面板最容易踩的路径漂移。
 * 这里只做**字符串归一化**，不碰远端真实路径——realpath 仍由 `resolve` 负责。
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeRemotePath(input) {
  const raw = String(input ?? '')
  if (raw.includes('\0')) throw fsError('远端路径不能包含 NUL', 'FS_INVALID_ARGUMENT')
  if (raw === '') return '/'
  const absolute = raw.startsWith('/')
  const out = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  if (absolute) return joined === '' ? '/' : `/${joined}`
  return joined === '' ? '.' : joined
}

/** 远端 POSIX 路径拼接（避免手写 `${dir}/${name}` 在根目录产生 `//`）。 */
function joinRemotePath(dir, name) {
  const base = normalizeRemotePath(dir)
  const leaf = String(name ?? '')
  if (leaf === '') return base
  return base === '/' ? `/${leaf}` : `${base}/${leaf}`
}

/** sftp 错误码 → dsh-fs 错误码。 */
function mapSftpError(error, remotePath) {
  const text = String(error?.message ?? error)
  if (typeof error?.code === 'number') {
    // ssh2 SFTP STATUS_CODE: 2 = NO_SUCH_FILE, 3 = PERMISSION_DENIED
    if (error.code === 2) return fsError(`远端文件不存在：${remotePath}`, 'FS_NOT_FOUND', error)
    if (error.code === 3) return fsError(`远端拒绝访问：${remotePath}`, 'FS_PERMISSION_DENIED', error)
  }
  if (/no such file/i.test(text)) return fsError(`远端文件不存在：${remotePath}`, 'FS_NOT_FOUND', error)
  if (/permission denied/i.test(text)) return fsError(`远端拒绝访问：${remotePath}`, 'FS_PERMISSION_DENIED', error)
  return fsError(`远端 I/O 失败（${remotePath}）：${text}`, 'FS_IO_ERROR', error)
}

/* ---------- 远端清单 ---------- */

/**
 * 读取远端清单。每次操作前重读：文件小、改动低频，
 * 换来"改配置不用重启"是值的。文件缺失/损坏都按"没有远端"处理。
 * @param {string} file remotes.json 的绝对路径
 * @returns {Record<string, {host:string,port?:number,username:string,auth?:string,keyPath?:string,password?:string}>}
 */
export function readRemotes(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * 回环地址提示：127.0.0.1/localhost 指的是**运行 dsh web 的本机**，
 * 不是车端/NVR 等远端设备。现场最常见的误配之一，报错时直接点明。
 */
export function loopbackHint(host) {
  const value = String(host ?? '').trim().toLowerCase()
  return value === '127.0.0.1' || value === 'localhost' || value === '::1'
    ? '（127.0.0.1/localhost 是运行 dsh web 的本机，不是远端设备；请检查 SSH 会话的目标地址或跳板配置）'
    : ''
}

/** 解析 ~ 开头的私钥路径（ssh2 只认绝对路径）。 */
function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 校验远端别名。书签名会直接当别名用，所以允许中文、`+`、空格；
 * 只排除空串、`:`、`/` 和控制字符——前两者会和 `remote:别名:/路径` 语法冲突。
 */
export function normalizeRemoteAlias(raw) {
  const alias = String(raw ?? '').trim()
  if (
    alias === '' ||
    alias.includes(':') ||
    alias.includes('/') ||
    /[\u0000-\u001f\u007f]/.test(alias)
  ) {
    throw fsError(
      `远端别名不合法：${JSON.stringify(alias)}（不能为空，不能含 : 或 /）`,
      'FS_INVALID_ARGUMENT',
    )
  }
  return alias
}

/**
 * 归一化浏览器登记上来的连接配置（来自 SSH 书签）。
 * 只收连接必需字段，未知字段丢弃；密码只放内存，不落盘、不打日志。
 */
export function normalizeRemoteEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fsError('远端连接配置必须是对象', 'FS_INVALID_ARGUMENT')
  }
  const host = String(raw.host ?? '').trim()
  const username = String(raw.username ?? raw.user ?? '').trim()
  if (host === '') throw fsError('远端连接配置缺少 host', 'FS_INVALID_ARGUMENT')
  if (username === '') throw fsError('远端连接配置缺少 username', 'FS_INVALID_ARGUMENT')
  const port =
    raw.port === undefined || raw.port === null || raw.port === '' ? 22 : Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw fsError(`远端端口不合法：${String(raw.port)}`, 'FS_INVALID_ARGUMENT')
  }
  const auth = raw.auth === 'password' ? 'password' : raw.auth === 'key' ? 'key' : 'agent'
  const password = auth === 'password' ? String(raw.password ?? '') : ''
  if (auth === 'password' && password === '') {
    throw fsError('密码认证的远端连接缺少 password', 'FS_INVALID_ARGUMENT')
  }
  const keyPath = String(raw.keyPath ?? '').trim()
  return { host, port, username, auth, password, keyPath }
}

/* ---------- SSH 连接池 ---------- */

/**
 * 按别名懒建立、断线自动重连的 SSH 连接池。
 * 同一别名并发取连接时共享同一次握手（connecting Promise）。
 */
class ConnectionPool {
  constructor(remotesFile) {
    this.remotesFile = remotesFile
    /** @type {Map<string, {client: any, sftp: any, configKey: string}>} */
    this.live = new Map()
    /** @type {Map<string, Promise<{client:any,sftp:any}>>} */
    this.connecting = new Map()
    /** 浏览器从 SSH 书签登记上来的连接配置：只放内存，进程退出即丢。 */
    this.dynamic = new Map()
  }

  /** 配置内容指纹：改了就丢掉旧连接重连。 */
  configKey(entry) {
    return JSON.stringify([entry.host, entry.port ?? 22, entry.username, entry.auth ?? 'key', entry.keyPath ?? '', entry.password ?? ''])
  }

  /** 合并后的别名清单：文件配置优先，动态登记补缺。 */
  aliases() {
    const names = new Set(Object.keys(readRemotes(this.remotesFile)))
    for (const alias of this.dynamic.keys()) names.add(alias)
    return [...names]
  }

  /** 取某个别名的连接配置；remotes.json 显式配置优先于书签登记。 */
  entryOf(alias) {
    const remotes = readRemotes(this.remotesFile)
    if (Object.prototype.hasOwnProperty.call(remotes, alias)) return remotes[alias]
    return this.dynamic.get(alias)
  }

  /**
   * 登记一份浏览器侧连接配置（来自 SSH 书签）。
   * 同别名配置变了就丢掉旧连接，下一次取通道时重连。
   */
  register(alias, rawEntry) {
    const name = normalizeRemoteAlias(alias)
    const entry = normalizeRemoteEntry(rawEntry)
    const key = this.configKey(entry)
    const live = this.live.get(name)
    if (live !== undefined && live.configKey !== key) this.drop(name)
    this.dynamic.set(name, entry)
    return name
  }

  /**
   * 注销一份浏览器侧登记（只删动态表，remotes.json 里的同名配置不受影响）。
   * 用于测试收尾和面板主动清理：动态表是进程级的，假别名留在这里会一直
   * 出现在所有窗口的远端选择器里。
   */
  unregister(alias) {
    const name = normalizeRemoteAlias(alias)
    this.drop(name)
    return this.dynamic.delete(name)
  }

  /**
   * 取一个可用 SFTP 通道（必要时先握手）。
   * @param {string} alias 远端别名
   * @returns {Promise<any>} sftp 会话
   */
  async sftp(alias) {
    const entry = this.entryOf(alias)
    if (entry === undefined) {
      const known = this.aliases()
      throw fsError(
        known.length === 0
          ? `远端「${alias}」未配置：${this.remotesFile} 里还没有任何远端`
          : `远端「${alias}」未配置，已配置：${known.join('、')}`,
        'FS_NOT_FOUND',
      )
    }
    const key = this.configKey(entry)
    const live = this.live.get(alias)
    if (live !== undefined && live.configKey === key) return live.sftp
    this.drop(alias)
    let pending = this.connecting.get(alias)
    if (pending === undefined) {
      pending = this.connect(alias, entry, key)
      this.connecting.set(alias, pending)
      try {
        await pending
      } finally {
        this.connecting.delete(alias)
      }
    }
    return (await pending).sftp
  }

  async connect(alias, entry, key) {
    // ssh2 是 CJS；插件是 ESM，default 导入拿到 { Client }。
    const { Client } = await import('ssh2')
    const client = new Client()
    const sftp = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH 握手超时（15s）')), 15000)
      client
        .on('ready', () => {
          client.sftp((error, sftp) => {
            clearTimeout(timer)
            if (error) reject(error)
            else resolve(sftp)
          })
        })
        .on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        .connect({
          host: entry.host,
          port: entry.port ?? 22,
          username: entry.username,
          privateKey: entry.auth === 'password' ? undefined : readKey(entry),
          password: entry.auth === 'password' ? entry.password : undefined,
          readyTimeout: 15000,
        })
    }).catch((error) => {
      try {
        client.end()
      } catch {
        /* 本就半死 */
      }
      throw fsError(
        `SSH 连接失败（${alias} ${entry.username}@${entry.host}）：${error?.message ?? error}${loopbackHint(entry.host)}`,
        'FS_IO_ERROR',
        error,
      )
    })
    const record = { client, sftp, configKey: key }
    client.on('close', () => {
      if (this.live.get(alias) === record) this.live.delete(alias)
    })
    this.live.set(alias, record)
    return record
  }

  drop(alias) {
    const live = this.live.get(alias)
    if (live === undefined) return
    this.live.delete(alias)
    try {
      live.client.end()
    } catch {
      /* 忽略 */
    }
  }

  dispose() {
    for (const alias of [...this.live.keys()]) this.drop(alias)
    this.dynamic.clear()
  }
}

function readKey(entry) {
  const keyPath = expandHome(entry.keyPath ?? '~/.ssh/id_rsa')
  try {
    return fs.readFileSync(keyPath)
  } catch (error) {
    throw fsError(`读不到私钥 ${keyPath}：${error?.message ?? error}`, 'FS_IO_ERROR', error)
  }
}

/* ---------- 远端后端 ---------- */

/** sftp promise 化的小工具集（ssh2 的 sftp 全是回调）。 */
function p(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => (error ? reject(error) : resolve(result)))
  })
}

/**
 * 一个别名的远端后端。实现 dsh-fs FileSystem 的方法表面
 * （不继承 Service——它不注册槽位，只是路由目标）。
 */
class RemoteBackend {
  /**
   * @param {string} alias
   * @param {ConnectionPool} pool
   */
  constructor(alias, pool) {
    this.alias = alias
    this.pool = pool
  }

  /** 远端 stats → FsInfo/FsPathInfo。版本用 ino+mtime+size（同本地后端思路）。 */
  info(stats) {
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
    const version = `${stats.ino ?? 0}-${Math.round((stats.mtime ?? 0) * 1000)}-${stats.size ?? 0}`
    return { version, type, size: stats.isFile() ? stats.size : undefined }
  }

  makeTarget(real) {
    return {
      targetKey: `${KEY_PREFIX}${this.alias}://${real}`,
      displayPath: `remote:${this.alias}:${real}`,
    }
  }

  /** 从 targetKey 还原远端绝对路径（只给本模块内部用）。 */
  static pathOf(targetKey) {
    const match = KEY_RE.exec(String(targetKey))
    return match === null ? undefined : { alias: match[1], path: match[2] }
  }

  async resolve(remotePath, opts) {
    const sftp = await this.pool.sftp(this.alias)
    // 相对路径（理论上 wrapper 已挡掉）退到远端 home：sftp realpath('.')。
    const normalized = normalizeRemotePath(remotePath)
    const base = normalized.startsWith('/') ? normalized : `.${normalized.startsWith('/') ? '' : '/'}${normalized}`
    let real
    try {
      real = await p(sftp, 'realpath', base)
    } catch (error) {
      // 文件不存在时 realpath 失败：退回规范化拼接（允许"待创建"目标）。
      real = base === '.' ? '/' : base
    }
    opts?.signal?.throwIfAborted?.()
    return this.makeTarget(real)
  }

  async stat(remotePath) {
    const target = normalizeRemotePath(remotePath)
    const sftp = await this.pool.sftp(this.alias)
    try {
      return this.info(await p(sftp, 'stat', target))
    } catch (error) {
      if (error?.code === 2 || /no such file/i.test(String(error?.message))) return undefined
      throw mapSftpError(error, target)
    }
  }

  async lstat(remotePath) {
    const target = normalizeRemotePath(remotePath)
    const sftp = await this.pool.sftp(this.alias)
    try {
      const stats = await p(sftp, 'lstat', target)
      const base = this.info(stats)
      if (stats.isSymbolicLink?.()) base.type = 'symlink'
      return base
    } catch (error) {
      if (error?.code === 2 || /no such file/i.test(String(error?.message))) return undefined
      throw mapSftpError(error, target)
    }
  }

  async listDir(remotePath) {
    const target = normalizeRemotePath(remotePath)
    const sftp = await this.pool.sftp(this.alias)
    let entries
    try {
      entries = await p(sftp, 'readdir', target)
    } catch (error) {
      throw mapSftpError(error, target)
    }
    return entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
      .map((entry) => {
        const childPath = joinRemotePath(target, entry.filename)
        const stats = entry.attrs
        const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
        return {
          name: entry.filename,
          type,
          target: this.makeTarget(childPath),
          version: `${stats.ino ?? 0}-${Math.round((stats.mtime ?? 0) * 1000)}-${stats.size ?? 0}`,
          size: type === 'file' ? stats.size : undefined,
        }
      })
  }

  /** 全量读（带大小闸门）。返回 Buffer；文本/二进制判定在调用方。 */
  async readBytes(remotePath, maxBytes = MAX_READ_BYTES) {
    remotePath = normalizeRemotePath(remotePath)
    const head = await this.stat(remotePath)
    if (head === undefined) throw fsError(`远端文件不存在：${remotePath}`, 'FS_NOT_FOUND')
    if (head.type !== 'file') throw fsError(`不是普通文件：remote:${this.alias}:${remotePath}`, 'FS_NOT_REGULAR_FILE')
    if (head.size !== undefined && head.size > maxBytes) {
      throw fsError(`远端文件太大（${head.size} 字节 > 上限 ${maxBytes}）`, 'FS_TOO_LARGE')
    }
    const sftp = await this.pool.sftp(this.alias)
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      const stream = sftp.createReadStream(remotePath)
      stream.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          stream.destroy()
          reject(fsError(`远端文件太大（超过 ${maxBytes} 字节）`, 'FS_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', (error) => reject(mapSftpError(error, remotePath)))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  /** 文本读：UTF-8 解码，含非法字节/二进制判负，LF 归一化。 */
  async readText(remotePath) {
    const bytes = await this.readBytes(remotePath)
    if (bytes.includes(0)) throw fsError(`远端文件不是文本（含 NUL）：remote:${this.alias}:${remotePath}`, 'FS_NOT_TEXT')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text
    try {
      text = decoder.decode(bytes)
    } catch {
      throw fsError(`远端文件不是 UTF-8 文本：remote:${this.alias}:${remotePath}`, 'FS_NOT_TEXT')
    }
    return text.replace(/\r\n/g, '\n')
  }

  /** 区间读（窗口式，有界）。 */
  async readByteRange(remotePath, offset, length) {
    remotePath = normalizeRemotePath(remotePath)
    const sftp = await this.pool.sftp(this.alias)
    const handle = await p(sftp, 'open', remotePath, 'r').catch((error) => {
      throw mapSftpError(error, remotePath)
    })
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await new Promise((resolve, reject) => {
        sftp.read(handle, buffer, 0, length, offset, (error, bytesRead) => (error ? reject(error) : resolve({ bytesRead })))
      })
      return new Uint8Array(buffer.subarray(0, bytesRead))
    } catch (error) {
      throw mapSftpError(error, remotePath)
    } finally {
      p(sftp, 'close', handle).catch(() => {})
    }
  }

  /**
   * 原子写：先读 before（存在且是文本时），写临时文件再 rename 发布。
   * SFTP rename 在大多数服务端是同目录原子的。
   */
  async writeText(remotePath, content, expected) {
    remotePath = normalizeRemotePath(remotePath)
    const beforeInfo = await this.stat(remotePath)
    if (expected?.kind === 'createIfAbsent' && beforeInfo !== undefined) {
      throw fsError(`远端文件已存在，违反 createIfAbsent：remote:${this.alias}:${remotePath}`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (beforeInfo === undefined) throw fsError(`远端文件已不存在（写前被删）：remote:${this.alias}:${remotePath}`, 'FS_STALE_VERSION')
      if (beforeInfo.version !== expected.version) {
        throw fsError(`远端文件版本已变化（写前被改）：remote:${this.alias}:${remotePath}`, 'FS_STALE_VERSION')
      }
    }
    let before = null
    if (beforeInfo !== undefined && beforeInfo.type === 'file') {
      try {
        before = await this.readText(remotePath)
      } catch {
        before = null // 二进制/读不了的旧文件：不给 diff 基（契约允许 null）
      }
    }
    const sftp = await this.pool.sftp(this.alias)
    const data = Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8')
    const tmp = `${remotePath}.dsh-twb-${process.pid}-${Date.now()}.tmp`
    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(tmp)
      stream.on('error', (error) => reject(mapSftpError(error, tmp)))
      stream.on('close', () => resolve())
      stream.end(data)
    })
    try {
      /* 覆盖发布的优先级：
         1. posix-rename@openssh.com 扩展（OpenSSH ≥ 4.8）：原子覆盖，首选；
         2. 协议 v3 rename：不允许覆盖——已存在目标时只能先 unlink，
            这中间有一个"旧文件已删、新文件未到位"的窗口，只在扩展缺席时走。 */
      let published = false
      if (typeof sftp.ext_openssh_rename === 'function') {
        published = await new Promise((resolve) => {
          sftp.ext_openssh_rename(tmp, remotePath, (error) => resolve(error === null || error === undefined))
        })
      }
      if (!published) {
        if (beforeInfo !== undefined) await p(sftp, 'unlink', remotePath).catch(() => {})
        await p(sftp, 'rename', tmp, remotePath)
      }
    } catch (error) {
      p(sftp, 'unlink', tmp).catch(() => {})
      throw mapSftpError(error, remotePath)
    }
    const afterInfo = await this.stat(remotePath)
    return {
      operation: beforeInfo === undefined ? 'create' : 'update',
      version: afterInfo?.version ?? `unknown-${Date.now()}`,
      before,
      after: content.replace(/\r\n/g, '\n'),
    }
  }

  /** 字面替换编辑：读 → 校验守卫 → 替换 → 原子写。 */
  async editText(remotePath, edit, expected) {
    const beforeInfo = await this.stat(remotePath)
    if (beforeInfo === undefined) throw fsError(`远端文件不存在：remote:${this.alias}:${remotePath}`, 'FS_NOT_FOUND')
    if (expected?.version !== undefined && beforeInfo.version !== expected.version) {
      throw fsError(`远端文件版本已变化（编辑前被改）：remote:${this.alias}:${remotePath}`, 'FS_STALE_VERSION')
    }
    const before = await this.readText(remotePath)
    const matches = before.split(edit.oldString).length - 1
    if (matches === 0) throw fsError(`找不到要替换的文本：remote:${this.alias}:${remotePath}`, 'FS_EDIT_NOT_FOUND')
    if (matches > 1 && !edit.replaceAll) {
      throw fsError(`要替换的文本出现 ${matches} 次，不唯一（replaceAll 未开）`, 'FS_AMBIGUOUS_EDIT')
    }
    const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, edit.newString)
    const outcome = await this.writeText(remotePath, after, {
      kind: 'replaceIfVersion',
      version: beforeInfo.version,
    })
    return { version: outcome.version, before, after }
  }

  /**
   * 创建目录。`recursive: true` 时逐级创建——SFTP 协议 v3 没有 mkdir -p；
   * 已存在且是目录直接返回，天然幂等。
   */
  async mkdir(remotePath, opts = {}) {
    const target = normalizeRemotePath(remotePath)
    if (target === '/') return { path: '/', created: false }
    const recursive = opts?.recursive === true
    const existing = await this.stat(target)
    if (existing !== undefined) {
      if (existing.type === 'directory') return { path: target, created: false }
      throw fsError(`远端路径已存在且不是目录：remote:${this.alias}:${target}`, 'FS_NOT_DIRECTORY')
    }
    const sftp = await this.pool.sftp(this.alias)
    if (!recursive) {
      const parent = path.posix.dirname(target)
      const parentInfo = await this.stat(parent)
      if (parentInfo === undefined) {
        throw fsError(`父目录不存在：remote:${this.alias}:${parent}`, 'FS_NOT_FOUND')
      }
      if (parentInfo.type !== 'directory') {
        throw fsError(`父路径不是目录：remote:${this.alias}:${parent}`, 'FS_NOT_DIRECTORY')
      }
      try {
        await p(sftp, 'mkdir', target)
      } catch (error) {
        throw mapSftpError(error, target)
      }
      return { path: target, created: true }
    }
    let current = ''
    for (const segment of target.split('/').filter(Boolean)) {
      current += `/${segment}`
      const info = await this.stat(current)
      if (info !== undefined) {
        if (info.type !== 'directory') {
          throw fsError(`远端路径已存在且不是目录：remote:${this.alias}:${current}`, 'FS_NOT_DIRECTORY')
        }
        continue
      }
      try {
        await p(sftp, 'mkdir', current)
      } catch (error) {
        /* 并发创建时对方可能刚好先成功；失败后再确认一次，避免把成功当失败。 */
        const raced = await this.stat(current)
        if (raced?.type === 'directory') continue
        throw mapSftpError(error, current)
      }
    }
    return { path: target, created: true }
  }

  /**
   * 删除文件或目录。目录默认必须为空；递归删除必须显式 `recursive: true`。
   * 拒绝删除远端根目录——这是不可逆操作的最后一道硬边界。
   */
  async remove(remotePath, opts = {}) {
    const target = normalizeRemotePath(remotePath)
    if (target === '/') throw fsError('拒绝删除远端根目录', 'FS_INVALID_ARGUMENT')
    const info = await this.lstat(target)
    if (info === undefined) throw fsError(`远端路径不存在：remote:${this.alias}:${target}`, 'FS_NOT_FOUND')
    const sftp = await this.pool.sftp(this.alias)
    if (info.type === 'directory') {
      const entries = await this.listDir(target)
      if (entries.length > 0 && opts?.recursive !== true) {
        throw fsError(
          `远端目录非空（${entries.length} 项），请显式 recursive: true：remote:${this.alias}:${target}`,
          'FS_DIR_NOT_EMPTY',
        )
      }
      if (opts?.recursive === true) {
        for (const entry of entries) await this.remove(joinRemotePath(target, entry.name), { recursive: true })
      }
      try {
        await p(sftp, 'rmdir', target)
      } catch (error) {
        throw mapSftpError(error, target)
      }
      return { path: target, type: 'directory' }
    }
    try {
      await p(sftp, 'unlink', target)
    } catch (error) {
      throw mapSftpError(error, target)
    }
    return { path: target, type: info.type }
  }

  /**
   * 移动 / 改名。同机内优先 `posix-rename@openssh.com`（原子覆盖）；
   * 不支持扩展时才退回「删目标 → rename」，并明确拒绝覆盖非空目录。
   */
  async rename(fromPath, toPath) {
    const from = normalizeRemotePath(fromPath)
    const to = normalizeRemotePath(toPath)
    if (from === to) return { from, to, replaced: false, noop: true }
    const source = await this.lstat(from)
    if (source === undefined) throw fsError(`远端路径不存在：remote:${this.alias}:${from}`, 'FS_NOT_FOUND')
    if (to === '/') throw fsError('拒绝把路径改名为远端根目录', 'FS_INVALID_ARGUMENT')
    const sftp = await this.pool.sftp(this.alias)
    let targetInfo = await this.lstat(to)
    if (typeof sftp.ext_openssh_rename === 'function') {
      const ok = await new Promise((resolve) => {
        sftp.ext_openssh_rename(from, to, (error) => resolve(error === undefined || error === null))
      })
      if (ok) return { from, to, replaced: targetInfo !== undefined }
      /* 扩展存在但失败（跨设备/权限/目标类型）时继续走兼容路径。 */
      targetInfo = await this.lstat(to)
    }
    if (targetInfo !== undefined) {
      if (targetInfo.type === 'directory') {
        const entries = await this.listDir(to)
        if (entries.length > 0) {
          throw fsError(`目标目录非空，不能覆盖：remote:${this.alias}:${to}`, 'FS_DIR_NOT_EMPTY')
        }
        await p(sftp, 'rmdir', to)
      } else {
        await p(sftp, 'unlink', to)
      }
    }
    try {
      await p(sftp, 'rename', from, to)
    } catch (error) {
      throw mapSftpError(error, to)
    }
    return { from, to, replaced: targetInfo !== undefined }
  }

  /** 同机复制：文件走 SFTP 流，目录递归；不经过本地磁盘。 */
  async copy(fromPath, toPath) {
    const from = normalizeRemotePath(fromPath)
    const to = normalizeRemotePath(toPath)
    if (from === to) return { from, to, type: 'noop' }
    const info = await this.lstat(from)
    if (info === undefined) throw fsError(`远端路径不存在：remote:${this.alias}:${from}`, 'FS_NOT_FOUND')
    if (info.type === 'directory') {
      const targetInfo = await this.stat(to)
      if (targetInfo !== undefined && targetInfo.type !== 'directory') {
        throw fsError(`目标已存在且不是目录：remote:${this.alias}:${to}`, 'FS_NOT_DIRECTORY')
      }
      await this.mkdir(to, { recursive: true })
      for (const entry of await this.listDir(from)) {
        await this.copy(joinRemotePath(from, entry.name), joinRemotePath(to, entry.name))
      }
      return { from, to, type: 'directory' }
    }
    if (info.type !== 'file') {
      throw fsError(`只支持复制普通文件或目录：remote:${this.alias}:${from}`, 'FS_NOT_REGULAR_FILE')
    }
    await this.copyFile(from, to)
    return { from, to, type: 'file' }
  }

  /** 单文件流式复制 + 临时文件发布，避免读满 64MB 闸门。 */
  async copyFile(from, to) {
    const targetInfo = await this.stat(to)
    if (targetInfo?.type === 'directory') {
      throw fsError(`目标已存在且是目录：remote:${this.alias}:${to}`, 'FS_NOT_DIRECTORY')
    }
    const sftp = await this.pool.sftp(this.alias)
    const tmp = `${to}.dsh-twb-copy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
    await new Promise((resolve, reject) => {
      const read = sftp.createReadStream(from)
      const write = sftp.createWriteStream(tmp)
      const fail = (error) => {
        read.destroy()
        write.destroy()
        reject(mapSftpError(error, from))
      }
      read.on('error', fail)
      write.on('error', fail)
      write.on('close', resolve)
      read.pipe(write)
    })
    try {
      await this.publishTemp(sftp, tmp, to, targetInfo)
    } catch (error) {
      p(sftp, 'unlink', tmp).catch(() => {})
      throw error
    }
    return { from, to, type: 'file' }
  }

  /** 临时文件发布：优先原子覆盖扩展，否则 unlink 旧目标再 rename。 */
  async publishTemp(sftp, tmp, target, targetInfo) {
    let published = false
    if (typeof sftp.ext_openssh_rename === 'function') {
      published = await new Promise((resolve) => {
        sftp.ext_openssh_rename(tmp, target, (error) => resolve(error === undefined || error === null))
      })
    }
    if (!published) {
      if (targetInfo !== undefined) await p(sftp, 'unlink', target).catch(() => {})
      await p(sftp, 'rename', tmp, target)
    }
  }

  /**
   * 跨后端直传：两个 SFTP 流直接对接，不经过本地磁盘。
   * 目标后端由调用方传入（同一 RemoteBackend 类，不同 alias）。
   */
  async copyTo(targetBackend, fromPath, toPath) {
    const from = normalizeRemotePath(fromPath)
    const to = normalizeRemotePath(toPath)
    if (this.alias === targetBackend.alias) return this.copy(from, to)
    if (from === to) return { from, to, type: 'noop' }
    const info = await this.lstat(from)
    if (info === undefined) throw fsError(`远端路径不存在：remote:${this.alias}:${from}`, 'FS_NOT_FOUND')
    if (info.type === 'directory') {
      const targetInfo = await targetBackend.stat(to)
      if (targetInfo !== undefined && targetInfo.type !== 'directory') {
        throw fsError(`目标已存在且不是目录：remote:${targetBackend.alias}:${to}`, 'FS_NOT_DIRECTORY')
      }
      await targetBackend.mkdir(to, { recursive: true })
      for (const entry of await this.listDir(from)) {
        await this.copyTo(targetBackend, joinRemotePath(from, entry.name), joinRemotePath(to, entry.name))
      }
      return { from, to, type: 'directory', fromAlias: this.alias, toAlias: targetBackend.alias }
    }
    if (info.type !== 'file') {
      throw fsError(`只支持复制普通文件或目录：remote:${this.alias}:${from}`, 'FS_NOT_REGULAR_FILE')
    }
    const targetInfo = await targetBackend.stat(to)
    if (targetInfo?.type === 'directory') {
      throw fsError(`目标已存在且是目录：remote:${targetBackend.alias}:${to}`, 'FS_NOT_DIRECTORY')
    }
    const sourceSftp = await this.pool.sftp(this.alias)
    const targetSftp = await targetBackend.pool.sftp(targetBackend.alias)
    const tmp = `${to}.dsh-twb-copy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
    await new Promise((resolve, reject) => {
      const read = sourceSftp.createReadStream(from)
      const write = targetSftp.createWriteStream(tmp)
      const fail = (error) => {
        read.destroy()
        write.destroy()
        reject(mapSftpError(error, from))
      }
      read.on('error', fail)
      write.on('error', fail)
      write.on('close', resolve)
      read.pipe(write)
    })
    try {
      await targetBackend.publishTemp(targetSftp, tmp, to, targetInfo)
    } catch (error) {
      p(targetSftp, 'unlink', tmp).catch(() => {})
      throw error
    }
    return { from, to, type: 'file', fromAlias: this.alias, toAlias: targetBackend.alias }
  }
}

/* ---------- ctx.fs 复合包装 ---------- */

/**
 * 把 `ctx.fs` 包成"本地 + 远端"复合后端（v0.6.0 入口）。
 *
 * 做法：给现有实例的方法套一层路由壳。命中远端语义的转给
 * RemoteBackend，其余原样调用——本地行为逐字节不变。
 *
 * @param {any} ctx 插件上下文（需 inject: ['fs']）
 * @param {string} remotesFile remotes.json 绝对路径
 */
export function wrapFileSystem(ctx, remotesFile) {
  const base = ctx.fs
  if (base === undefined || base === null || typeof base.resolve !== 'function') {
    console.warn('[terminal-workbench] ctx.fs 尚未就绪，远端文件挂载跳过')
    const unavailable = async () => {
      throw fsError('fs 服务未就绪，远端文件暂不可用', 'FS_IO_ERROR')
    }
    return {
      probe: async () => 'fs 服务未就绪',
      backendOf() {
        throw fsError('fs 服务未就绪，远端文件暂不可用', 'FS_IO_ERROR')
      },
      copyBetween: unavailable,
      aliases: () => [],
      entries: () => ({}),
      registerRemote() {
        throw fsError('fs 服务未就绪，远端文件暂不可用', 'FS_IO_ERROR')
      },
      unregisterRemote() {
        throw fsError('fs 服务未就绪，远端文件暂不可用', 'FS_IO_ERROR')
      },
      dispose() {},
    }
  }
  if (base.__twbRemoteWrapped === true && base.__twbRemoteHandle !== undefined) {
    console.log('[terminal-workbench] ctx.fs 已包装过，复用首次包装句柄')
    return base.__twbRemoteHandle
  }

  const pool = new ConnectionPool(remotesFile)
  /** @type {Map<string, RemoteBackend>} */
  const backends = new Map()
  const backendOf = (alias) => {
    let backend = backends.get(alias)
    if (backend === undefined) {
      backend = new RemoteBackend(alias, pool)
      backends.set(alias, backend)
    }
    return backend
  }

  /** path 形参路由：`remote:别名:/路径` → { alias, path }，否则 undefined。 */
  const routePath = (p) => {
    if (typeof p !== 'string') return undefined
    const match = PATH_RE.exec(p)
    return match === null ? undefined : { alias: match[1], path: match[2] }
  }

  /** target 形参路由：targetKey 前缀 → { alias, path }，否则 undefined。 */
  const routeTarget = (target) => {
    if (target === null || typeof target !== 'object') return undefined
    return RemoteBackend.pathOf(target.targetKey)
  }

  const original = {}
  const wrap = (name, fn) => {
    original[name] = base[name]
    base[name] = fn
  }

  /* resolve：path 形参。远端路径走远端 realpath，其余透传。 */
  wrap('resolve', async function (p, opts) {
    const route = routePath(p)
    if (route === undefined) return original.resolve.call(base, p, opts)
    return backendOf(route.alias).resolve(route.path, opts)
  })

  /* lstat：path 形参。 */
  wrap('lstat', async function (p, opts, signal) {
    const route = routePath(p)
    if (route === undefined) return original.lstat.call(base, p, opts, signal)
    signal?.throwIfAborted?.()
    return backendOf(route.alias).lstat(route.path)
  })

  /* 以下全是 target 形参：看 targetKey 前缀。 */
  const wrapTarget = (name, remoteCall) => {
    wrap(name, async function (target, ...rest) {
      const route = routeTarget(target)
      if (route === undefined) return original[name].call(base, target, ...rest)
      return remoteCall(backendOf(route.alias), route.path, ...rest)
    })
  }

  wrapTarget('stat', (backend, remotePath) => backend.stat(remotePath))
  wrapTarget('readText', (backend, remotePath) => backend.readText(remotePath))
  wrapTarget('streamText', async (backend, remotePath) => {
    // 消费方拿到的是 AsyncIterable；整读 + 按行切块，远端场景足够（文件有大小闸门）。
    const text = await backend.readText(remotePath)
    return (async function* () {
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        yield index === lines.length - 1 ? lines[index] : `${lines[index]}\n`
      }
    })()
  })
  wrapTarget('readBytes', (backend, remotePath, _signal, maxBytes) => backend.readBytes(remotePath, maxBytes ?? MAX_READ_BYTES))
  wrapTarget('readByteRange', (backend, remotePath, range, _signal) => backend.readByteRange(remotePath, range.offset, range.length))
  wrapTarget('listDir', (backend, remotePath) => backend.listDir(remotePath))
  wrapTarget('writeText', (backend, remotePath, content, expected) => backend.writeText(remotePath, content, expected))
  wrapTarget('editText', (backend, remotePath, edit, expected) => backend.editText(remotePath, edit, expected))

  /* 同步方法。 */
  wrap('processPath', function (target) {
    const route = routeTarget(target)
    if (route === undefined) return original.processPath.call(base, target)
    return route.path // 远端执行世界里的绝对路径
  })
  wrap('fileUrl', function (target) {
    const route = routeTarget(target)
    if (route === undefined) return original.fileUrl.call(base, target)
    return `sftp://${route.alias}${route.path}`
  })
  wrap('contains', function (parent, child) {
    const pRoute = routeTarget(parent)
    const cRoute = routeTarget(child)
    if (pRoute === undefined && cRoute === undefined) return original.contains.call(base, parent, child)
    // 两端不同世界：永远不相含。
    if (pRoute === undefined || cRoute === undefined) return false
    if (pRoute.alias !== cRoute.alias) return false
    const prefix = pRoute.path === '/' ? '/' : `${pRoute.path}/`
    return cRoute.path === pRoute.path || cRoute.path.startsWith(prefix)
  })
  wrap('watch', function (target, changed, signal) {
    const route = routeTarget(target)
    if (route === undefined) return original.watch.call(base, target, changed, signal)
    signal?.throwIfAborted?.()
    return Promise.reject(fsError(`远端暂不支持文件监听：remote:${route.alias}:${route.path}`, 'FS_IO_ERROR'))
  })

  Object.defineProperty(base, '__twbRemoteWrapped', { value: true, enumerable: false, configurable: true, writable: true })

  console.log(`[terminal-workbench] ctx.fs 已包装为本地+远端复合后端（清单位置：${remotesFile}）`)

  /** 连通性探测：发起一次真实握手并 stat 远端根目录。 */
  const probe = async (alias) => {
    try {
      const sftp = await pool.sftp(alias)
      await p(sftp, 'stat', '/')
      return '连接正常'
    } catch (error) {
      return `连接失败：${error?.message ?? error}`
    }
  }

  /** `remote:别名:/路径` 解析成别名与路径；文件面板与工具层共用。 */
  const parseRemoteAddress = (raw) => {
    const match = PATH_RE.exec(String(raw ?? ''))
    if (match === null) {
      throw fsError(`路径要写成 remote:别名:/绝对/路径，收到：${raw}`, 'FS_INVALID_ARGUMENT')
    }
    return { alias: match[1], path: match[2] }
  }

  /** 取远端 realpath（`resolve` 返回的是 FsTarget，不是字符串）。 */
  const realpathOf = async (backend, remotePath) => {
    const target = await backend.resolve(remotePath, {})
    const match = /^remote\+[^:/]+:\/\/(.*)$/.exec(String(target?.targetKey ?? ''))
    return match === null ? normalizeRemotePath(remotePath) : match[1]
  }

  /**
   * 跨远端复制：`remote:别名:/路径` → `remote:别名:/路径`。
   * 同机走 `copy`，跨机走 `copyTo`（SFTP 流直连，不落本地磁盘）。
   */
  const copyBetween = async (fromRaw, toRaw) => {
    const from = parseRemoteAddress(fromRaw)
    const to = parseRemoteAddress(toRaw)
    const fromBackend = backendOf(from.alias)
    const toBackend = backendOf(to.alias)
    const fromPath = await realpathOf(fromBackend, from.path)
    const toPath = await realpathOf(toBackend, to.path)
    return fromBackend.copyTo(toBackend, fromPath, toPath)
  }

  const handle = {
    probe,
    backendOf,
    copyBetween,
    aliases: () => pool.aliases(),
    /** 别名 → 连接配置（remotes.json 与书签登记合并）。 */
    entries: () => {
      const merged = {}
      for (const alias of pool.aliases()) merged[alias] = pool.entryOf(alias)
      return merged
    },
    /** 浏览器打开文件面板时，把当前 SSH 书签的连接配置登记进来（只放内存）。 */
    registerRemote: (alias, entry) => pool.register(alias, entry),
    /** 注销动态登记（remotes.json 里的同名配置不动）。 */
    unregisterRemote: (alias) => pool.unregister(alias),
    remotesFile,
    dispose() {
      for (const [name, fn] of Object.entries(original)) base[name] = fn
      try {
        delete base.__twbRemoteWrapped
        delete base.__twbRemoteHandle
      } catch {
        /* 忽略 */
      }
      pool.dispose()
    },
  }
  Object.defineProperty(base, '__twbRemoteHandle', {
    value: handle,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return handle
}

/** 连接池只在这一个模块里活着；导出给工具层做"连通性自检"。 */
export { ConnectionPool, RemoteBackend, PATH_RE, KEY_RE, readKey, expandHome }
