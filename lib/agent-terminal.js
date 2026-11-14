/**
 * dsh-terminal-workbench —— 宿主半侧：把工作台终端接给模型。
 *
 * 职责边界（与主人约定）：
 *   1. 主人自己的终端 —— 只读。`terminal_read` attach 一下取屏幕快照，随即断开，
 *      不写任何输入。
 *   2. 我自己跑命令 —— 用专属终端（`agent-<session 尾段>`），不占用、不污染主人的标签。
 *   3. `terminal_run` / `terminal_send` 默认只作用于专属终端；`terminalId` 指向
 *      别人的终端时，必须**先过审批**（见下）。
 *
 * 审批门禁（v0.9.0：完全跟随 DSH 权限预设）：
 *   旧版只有工具描述里的一句"需要点名"，模型忽略它就能直接往主人的 shell 里打字。
 *   现在改为运行时强制：`tools/pre-execute` 拦截 `terminal_run` / `terminal_send`，
 *   目标是外部终端时按当前会话的 DSH 审批策略处理：
 *     - `approval=never`（danger-full-access 预设，DSH 不弹审批）→ 直接放行；
 *     - `approval=ask` / 读不到策略 → 返回 `{ kind: 'ask' }`，交给 DSH 审批面板，
 *       只有 `allowed-once` 才放行；审批服务缺席时 dsh-tools fail-closed。
 *   插件不再维护独立的终端授权表，也没有 `/terminal-access grant`。
 *
 *   专属终端的 id 由 agent 身份推导，模型无法伪造别人的 id 来绕过闸门；
 *   助手专属终端始终可写，不弹审批。
 *
 *   `terminal_list` 会同时返回结构化 `access`：
 *   `own`（助手专属）/ `writable`（never 下可写）/ `approval`（ask 下需审批）/
 *   `read-only`（已退出，仅可读）。
 *
 * 依赖：宿主 `terminalController`（PTY 与屏幕）与 `tools`（模型工具注册）。
 * 审批服务 `approval` 不进 inject：它只用于读取当前策略，缺席时按 ask 处理，
 * 由 dsh-tools 自己 fail-closed，插件不应因此挂着不激活。
 */

export const name = 'f-dsh-terminal-workbench-agent'
export const inject = ['terminalController', 'tools']

import { approvalPolicyOf, askForApproval } from './approval-policy.js'
import { registerTerminalAccessApi } from './terminal-access-api.js'

/** 默认的输出静止多久算"命令跑完了"。 */
const QUIET_MS = 700
/** 慢命令（装包/拉镜像/编译）的静止阈值：这类命令常常几十秒才吐一行。 */
const QUIET_MS_SLOW = 4000
/** 判为慢命令时给的最长等待（不给足就是必然超时）。 */
const SLOW_TIMEOUT_MS = 300000
/** 单次命令默认最长等待。 */
const DEFAULT_TIMEOUT_MS = 30000
/** 回给模型的屏幕文本上限，避免把上下文撑爆。 */
const MAX_RETURN_CHARS = 6000
/** 专属终端的初始尺寸。 */
const MY_COLS = 120
const MY_ROWS = 30

/** 需要审批闸门的工具：这两个会真的往终端写输入。 */
const WRITE_TOOLS = new Set(['terminal_run', 'terminal_send'])

/* eslint-disable no-control-regex */
/** 剥掉 ANSI 转义序列，只留人能读的文本。 */
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 慢命令特征表：命中任意一条就把静止阈值放宽。
 *
 * 为什么需要：QUIET_MS=700 对 `ls` 这类命令刚好，但装包、拉镜像、编译常常
 * 几十秒才刷新一行进度——中间那段"静止"会被误判成跑完，模型拿到的增量是空的，
 * 于是以为命令没输出。与其让模型去猜，不如按命令特征自适应。
 *
 * 保守原则：只放宽不收紧；没命中就用默认值，行为跟以前完全一致。
 */
const SLOW_PATTERNS = [
  /\bnpm\s+(install|ci|run\s+(build|test|lint))\b/,
  /\b(pnpm|yarn|bun)\s+(install|add|build)\b/,
  /\bpip3?\s+install\b/,
  /\b(apt|apt-get|yum|dnf|apk|brew)\s+(install|update|upgrade)\b/,
  /\bdocker\s+(pull|build|push)\b/,
  /\b(podman|nerdctl)\s+(pull|build)\b/,
  /\bgit\s+clone\b/,
  /\b(cargo|go)\s+(build|test|install|get)\b/,
  /\bgradlew?\s|\bmvn\b/,
  /\bmake\b/,
  /\bcmake\b/,
  /\brsync\b/,
  /\b(curl|wget)\b/,
  /\b(scp|sftp)\b/,
]

/**
 * 判断一条命令是否属于"输出稀疏的慢命令"，并给出配套的静止阈值与时限。
 * @param command - 待执行的命令行
 * @returns 阈值与时限；未命中返回默认值
 */
function pacingFor(command) {
  const text = String(command ?? '')
  const slow = SLOW_PATTERNS.some((pattern) => pattern.test(text))
  return slow ? { quietMs: QUIET_MS_SLOW, timeoutMs: SLOW_TIMEOUT_MS, slow: true } : { quietMs: QUIET_MS, timeoutMs: DEFAULT_TIMEOUT_MS, slow: false }
}

function plainText(text) {
  return String(text ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
}

/** 秘密字段名的判定：按 `_ - .` 切段，或整体以常见密钥词结尾。 */
function isSecretKey(key) {
  const normalized = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === '') return false
  if (normalized === 'pwd') return false /* PWD 是当前目录，不是密码 */
  const words = [
    'password',
    'passwd',
    'passphrase',
    'secret',
    'token',
    'apikey',
    'accesskey',
    'privatekey',
    'clientsecret',
    'credential',
    'credentials',
    'authorization',
    'auth',
    'pwd',
  ]
  return words.some((word) => normalized === word || normalized.endsWith(word))
}

/**
 * 送模型前的脱敏：命令与输出里可能带 token / 密码 / 私钥。
 *
 * 取舍：宁可多遮一点，也不把现场凭据写进会话上下文。`TOKENIZERS_PARALLELISM`
 * 这类只是"包含 token 字样"的普通变量不遮（按词尾判定），`PWD` 是目录不遮。
 * @param text - 原始文本
 * @returns 脱敏后的文本
 */
export function redactText(text) {
  let value = String(text ?? '')
  if (value === '') return value

  /* 1. 私钥整段隐藏（先做，避免后续规则破坏 BEGIN/END 配对）。 */
  value = value.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----***已隐藏***-----END PRIVATE KEY-----',
  )

  /* 2. URL 里的密码：scheme://user:pass@host → scheme://user:***@host */
  value = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, '$1***$3')

  /* 3. Bearer token / 常见平台 token 前缀。 */
  value = value.replace(/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1***')
  value = value.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***')
  value = value.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
  value = value.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '***')
  value = value.replace(/\bAKIA[0-9A-Z]{16}\b/g, '***')
  value = value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***')
  value = value.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***')

  /* 4. 带引号的 JSON / 配置键：{"password": "xxx"}。 */
  value = value.replace(
    /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("([^"\n]*)"|'([^'\n]*)'|[^\s&;|,}]+)/g,
    (whole, quote, key, sep) => (isSecretKey(key) ? `${quote}${key}${quote}${sep}***` : whole),
  )

  /* 5. KEY=value / KEY: value（环境变量、配置文件、日志里的键值对）。 */
  value = value.replace(
    /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\s*[=:]\s*)("([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|[^\s&;|,]+)/g,
    (whole, lead, key, sep, raw) => {
      if (!isSecretKey(key)) return whole
      return `${lead}${key}${sep}***`
    },
  )

  /* 6. 命令行参数：--password xxx / --token=xxx / --api-key xxx。 */
  value = value.replace(
    /(--?(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization|auth)\b)(\s+|=)("([^"\n]*)"|'([^'\n]*)'|[^\s]+)/gi,
    '$1$2***',
  )

  /* 7. sshpass -p / curl -u user:pass。 */
  value = value.replace(/(\bsshpass\b[^\n]*?\s-p\s*)("([^"\n]*)"|'([^'\n]*)'|[^\s]+)/gi, '$1***')
  value = value.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+)([^\s:]+):([^\s]+)/gi, '$1$2:***')

  return value
}

/**
 * 切给模型的文本：先剥 ANSI、再脱敏、最后按长度截断。
 * @param text - 原始文本
 * @param max - 最大字符数
 * @returns 可安全送模型的文本
 */
function clip(text, max = MAX_RETURN_CHARS) {
  const value = redactText(plainText(text))
  if (value.length <= max) return value
  return `…（前 ${value.length - max} 字已省略）…\n${value.slice(-max)}`
}

/**
 * 两份屏幕序列化的差集：按"行出现次数"做减法，保序留在 `after` 里多出来的行。
 *
 * 为什么不用更直观的两种写法：
 *   * 从头找第一处不同 —— 命令是**在提示符行上原地延伸**的，而且终端滚屏后
 *     整段上移，头部永远对不上，结果等于把整屏回给模型；模型每调一次就多背
 *     一遍历史，几轮就把上下文撑爆了。
 *   * 从尾部找公共尾巴 —— 提示符行只差中间一小段，尾巴能对上的行数很少，
 *     效果同样接近"整屏"。
 * 计数差不受滚动、重复行、原地改写影响，只吐真正新增的行。
 * @param before - 命令执行前的屏幕文本
 * @param after - 命令执行后的屏幕文本
 * @returns 新增行（按 `after` 中的原始顺序）
 */
function screenDelta(before, after) {
  const a = plainText(before).split('\n')
  const b = plainText(after).split('\n')
  const budget = new Map()
  for (const line of a) budget.set(line, (budget.get(line) ?? 0) + 1)
  const fresh = []
  for (const line of b) {
    const left = budget.get(line) ?? 0
    if (left > 0) budget.set(line, left - 1)
    else fresh.push(line)
  }
  /* 一条新行都没有（命令没有任何可见输出）时，回最后一行让模型知道光标在哪 */
  return fresh.length > 0 ? fresh.join('\n') : b.slice(-1).join('\n')
}

/* ------------------------------------------------------------------ */
/* OSC 133 命令块：宿主侧直接读 headless xterm 的标记                   */
/* ------------------------------------------------------------------ */

/** 每个终端保留的块数上限：够回看近期命令，又不至于把内存吃光。 */
const BLOCK_LIMIT = 200
/** 单块输出留存上限；返回给模型时还会再按 MAX_RETURN_CHARS 裁一次。 */
const BLOCK_OUTPUT_MAX = 8000
/** 块跟踪器挂在终端对象上的键：热重载时复用，避免重复注册 OSC 处理器。 */
const BLOCK_TRACKER = Symbol.for('dsh-terminal-workbench.block-tracker.v1')
/** controller 上的早绑定标记：热重载时不会重复包装 create。 */
const TRACKER_HOOKS = Symbol.for('dsh-terminal-workbench.block-tracker-hooks.v1')

/**
 * 解析 OSC 133 的 payload（`A` / `B` / `C` / `D;1`）。无法识别返回 null。
 * 与浏览器侧 `parseOsc133` 保持同一套语义，宿主与前端看到的是同一条流。
 * @param data - OSC 133 的 payload（不含 `133;` 前缀）
 * @returns 解析结果或 null
 */
export function parseOsc133(data) {
  const text = String(data ?? '')
  if (text === '') return null
  const cut = text.indexOf(';')
  const kind = cut === -1 ? text : text.slice(0, cut)
  const rest = cut === -1 ? '' : text.slice(cut + 1)
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null
  if (kind !== 'D') return { kind, payload: rest }
  const rcText = rest.split(';')[0]
  const rc = rcText === '' ? null : Number(rcText)
  return { kind: 'D', exitCode: Number.isFinite(rc) ? rc : null, payload: rest }
}

/** 解析 OSC 7 的 payload（`file://host/path` 或裸路径），返回路径。 */
export function parseOsc7(data) {
  const text = String(data ?? '').trim()
  if (text === '') return ''
  if (!text.startsWith('file://')) return text
  const rest = text.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return ''
  const pathPart = rest.slice(slash)
  try {
    return decodeURIComponent(pathPart)
  } catch {
    return pathPart
  }
}

/** headless xterm 的当前活动缓冲区。 */
function bufferOfTerminal(terminal) {
  return terminal?.screen?.buffer?.active
}

/** 光标所在的绝对行号（含回滚缓冲）。 */
function cursorLineOf(buffer) {
  if (buffer === undefined || buffer === null) return -1
  const base = Number(buffer.baseY)
  const cursor = Number(buffer.cursorY)
  if (!Number.isFinite(base) || !Number.isFinite(cursor)) return -1
  return base + cursor
}

/** 读缓冲区一行并转成纯文本；行不存在返回空串。 */
function lineTextOf(buffer, y) {
  if (buffer === undefined || buffer === null || typeof buffer.getLine !== 'function') return ''
  const line = buffer.getLine(y)
  if (line === undefined || line === null) return ''
  return typeof line.translateToString === 'function' ? line.translateToString(true) : String(line)
}

/**
 * 从 buffer 里截命令文本：B 标记之后到 C 标记之前。
 * @param buffer - xterm 活动缓冲区
 * @param fromLine - 命令起始绝对行
 * @param fromX - 命令起始列（提示符末尾）
 * @param toLine - 命令结束绝对行（C 所在行）
 * @param toX - 命令结束列
 * @returns 清理过尾部空白与空行的命令文本
 */
export function extractCommandBetween(buffer, fromLine, fromX, toLine, toX) {
  if (buffer === undefined || buffer === null || typeof buffer.getLine !== 'function') return ''
  const start = Math.max(0, Math.min(fromLine, toLine))
  const end = Math.max(fromLine, toLine)
  const lines = []
  for (let y = start; y <= end; y += 1) {
    let text = lineTextOf(buffer, y)
    if (y === fromLine && fromX > 0) text = text.slice(fromX)
    if (y === toLine) {
      const limit = toX - (y === fromLine ? Math.max(0, fromX) : 0)
      if (limit >= 0) text = text.slice(0, limit)
    }
    lines.push(text)
  }
  return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * 截取缓冲区的一段文本（含首尾行）。块输出就是 C→D 之间的这段。
 * @param buffer - xterm 活动缓冲区
 * @param fromLine - 起始绝对行
 * @param toLine - 结束绝对行
 * @returns 纯文本输出
 */
export function extractBufferRange(buffer, fromLine, toLine) {
  if (buffer === undefined || buffer === null || typeof buffer.getLine !== 'function') return ''
  const start = Math.max(0, Math.min(fromLine, toLine))
  const end = Math.max(fromLine, toLine)
  const lines = []
  for (let y = start; y <= end; y += 1) lines.push(lineTextOf(buffer, y))
  return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n+$/, '')
}

/** 由 marker 取当前行号；marker 已被裁掉时退回记录的数字。 */
function markerLineOf(marker, fallback) {
  if (marker !== undefined && marker !== null && typeof marker.line === 'number' && marker.line >= 0) return marker.line
  return typeof fallback === 'number' ? fallback : -1
}

function createMarker(terminal, offset = 0) {
  try {
    if (typeof terminal?.screen?.registerMarker === 'function') {
      const marker = terminal.screen.registerMarker(offset)
      if (marker !== undefined && marker !== null && typeof marker.line === 'number') return marker
    }
  } catch {
    /* 终端已销毁或版本不支持 marker：退回裸行号 */
  }
  return undefined
}

function disposeMarker(marker) {
  try {
    if (marker !== undefined && marker !== null && typeof marker.dispose === 'function') marker.dispose()
  } catch {
    /* 终端销毁后 dispose 可能抛错，忽略 */
  }
}

/** 块的对外状态：ok / fail / running / unknown。 */
export function blockStateOf(block) {
  if (block === undefined || block === null) return 'unknown'
  if (block.endedAt === undefined) return 'running'
  if (block.exitCode === 0) return 'ok'
  if (Number.isFinite(block.exitCode)) return 'fail'
  return 'unknown'
}

/** 毫秒 → 命令块耗时；短命令不显示 `0.0s` 这种没有信息量的文本。 */
export function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 60000) {
    const seconds = n / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`
  }
  let minutes = Math.floor(n / 60000)
  let rest = Math.round((n % 60000) / 1000)
  if (rest === 60) {
    minutes += 1
    rest = 0
  }
  return `${minutes}m${rest < 10 ? '0' : ''}${rest}s`
}

/**
 * 为一个 headless xterm 建立 OSC 133 块跟踪器。
 *
 * 与浏览器侧的区别：宿主没有"标签"概念，也拿不到可视滚动位置，只按
 * 终端 id 记录；输出在 D 到达时就地从 buffer 截下来，之后即使滚出回滚
 * 缓冲也不影响 `terminal_blocks` 的历史可读性。
 * @param terminal - BrowserTerminal（含 screen）
 * @param options - 测试注入点：now / limit
 * @returns 跟踪器；终端没有 parser 时返回 undefined
 */
export function createBlockTracker(terminal, options = {}) {
  const parser = terminal?.screen?.parser
  if (parser === undefined || parser === null || typeof parser.registerOscHandler !== 'function') return undefined
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : BLOCK_LIMIT
  const now = typeof options.now === 'function' ? options.now : Date.now
  const finished = []
  let open
  let prompt
  let seq = 0
  let cwd = ''
  let disposed = false

  /** 把当前打开的块收尾入库；exitCode 缺失表示未知。 */
  function close(exitCode, reason) {
    if (open === undefined) return undefined
    const block = open
    open = undefined
    const buffer = bufferOfTerminal(terminal)
    const startLine = markerLineOf(block.outputMarker, block.outputStartLine)
    const endLine = cursorLineOf(buffer)
    block.endedAt = now()
    block.exitCode = Number.isFinite(exitCode) ? exitCode : undefined
    block.endLine = endLine
    block.output = clipRaw(extractBufferRange(buffer, startLine, endLine), BLOCK_OUTPUT_MAX)
    if (reason !== undefined) block.reason = reason
    disposeMarker(block.outputMarker)
    block.outputMarker = undefined
    finished.push(block)
    while (finished.length > limit) finished.shift()
    return block
  }

  /** 极简的原文裁剪：块输出不做 ANSI 清理（xterm 已渲染成纯文本）。 */
  function clipRaw(text, max) {
    const value = String(text ?? '')
    if (value.length <= max) return value
    return `…（前 ${value.length - max} 字已省略）…\n${value.slice(-max)}`
  }

  function handle(data) {
    if (disposed) return false
    const event = parseOsc133(data)
    if (event === null) return false
    const buffer = bufferOfTerminal(terminal)
    if (buffer === undefined) return false
    const line = cursorLineOf(buffer)

    if (event.kind === 'A') {
      /* 上一条命令的 D 落在"新提示符所在行"：把上一块的结束行回退一行，
         免得边距/块输出把下一行提示符吃进来。光标不在行首时不做。 */
      const previous = finished[finished.length - 1]
      if (
        previous !== undefined &&
        buffer.cursorX === 0 &&
        line > 0 &&
        line >= previous.outputStartLine &&
        previous.endLine === line
      ) {
        previous.endLine = line - 1
        previous.output = clipRaw(
          extractBufferRange(buffer, previous.outputStartLine, previous.endLine),
          BLOCK_OUTPUT_MAX,
        )
      }
      if (prompt !== undefined) {
        disposeMarker(prompt.startMarker)
        disposeMarker(prompt.endMarker)
      }
      prompt = { startMarker: createMarker(terminal, 0), startLine: line }
      return true
    }

    if (event.kind === 'B') {
      if (prompt === undefined) prompt = { startMarker: createMarker(terminal, 0), startLine: line }
      prompt.endMarker = createMarker(terminal, 0)
      prompt.endLine = line
      prompt.endX = Number.isFinite(buffer.cursorX) ? buffer.cursorX : 0
      return true
    }

    if (event.kind === 'C') {
      const started = prompt
      const fromLine = started === undefined ? line : markerLineOf(started.endMarker, started.endLine ?? started.startLine)
      const fromX = Number.isFinite(started?.endX) ? started.endX : 0
      let command = started === undefined ? '' : extractCommandBetween(buffer, fromLine, fromX, line, buffer.cursorX)
      /* 少数 shell 集成把命令塞在 C 的 payload 里（`133;C;ls`）。 */
      if (command === '' && event.payload !== '') command = event.payload

      /* 没收到 D 又来 C（集成不完整/命令被信号打断）：先收尾上一条。 */
      if (open !== undefined) close(undefined, 'interrupted')

      seq += 1
      open = {
        id: seq,
        command,
        cwd,
        startedAt: now(),
        endedAt: undefined,
        exitCode: undefined,
        outputStartLine: line,
        outputMarker: createMarker(terminal, 0),
        endLine: undefined,
        output: '',
      }
      if (started !== undefined) disposeMarker(started.endMarker)
      prompt = undefined
      return true
    }

    /* D：命令结束。首个提示符的 D 没有对应 C，直接忽略。 */
    close(event.exitCode, undefined)
    return true
  }

  /** OSC 7：记录当前工作目录；ssh 会话里由远端 shell 的 precmd 发出。 */
  function handleCwd(data) {
    if (disposed) return false
    const next = parseOsc7(data)
    if (next !== '') cwd = next
    return true
  }

  const registration = parser.registerOscHandler(133, handle)
  const cwdRegistration = parser.registerOscHandler(7, handleCwd)

  return {
    get seq() {
      return seq
    },
    get open() {
      return open
    },
    get cwd() {
      return cwd
    },
    /** 已结束的块（按开始顺序）。 */
    list() {
      return finished.slice()
    },
    /** 包括正在执行的块。 */
    all() {
      return open === undefined ? finished.slice() : [...finished, open]
    },
    /** 找 seq 之后第一条已结束的块——runIn 用它确认"我这条命令跑完了"。 */
    completedSince(before) {
      for (const block of finished) {
        if (block.id > before) return block
      }
      return undefined
    },
    /** 按 id 找块（含正在执行的那条）。 */
    find(id) {
      const target = Number(id)
      if (!Number.isFinite(target)) return undefined
      if (open !== undefined && open.id === target) return open
      for (const block of finished) if (block.id === target) return block
      return undefined
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        if (typeof registration?.dispose === 'function') registration.dispose()
        else if (typeof registration === 'function') registration()
        if (typeof cwdRegistration?.dispose === 'function') cwdRegistration.dispose()
        else if (typeof cwdRegistration === 'function') cwdRegistration()
      } catch {
        /* 忽略 */
      }
      disposeMarker(prompt?.startMarker)
      disposeMarker(prompt?.endMarker)
      disposeMarker(open?.outputMarker)
      prompt = undefined
      open = undefined
      finished.length = 0
    },
  }
}

/**
 * 取（或惰性建立）某个终端的块跟踪器。
 * 挂在 BrowserTerminal 对象上，插件热重载时不会重复注册 OSC 处理器。
 * @param terminal - BrowserTerminal
 * @returns 跟踪器；终端不支持 parser 时返回 undefined
 */
export function blockTrackerOf(terminal) {
  if (terminal === undefined || terminal === null) return undefined
  const existing = terminal[BLOCK_TRACKER]
  if (existing !== undefined) return existing
  const tracker = createBlockTracker(terminal)
  if (tracker === undefined) return undefined
  try {
    Object.defineProperty(terminal, BLOCK_TRACKER, { value: tracker, enumerable: false, configurable: true })
  } catch {
    /* 对象不可扩展：仍返回本次实例，只是热重载后可能重复注册 */
  }
  return tracker
}

/**
 * 把块跟踪器提前挂到终端创建路径上。
 *
 * 为什么需要：`blockTrackerOf` 是惰性的，只有工具首次触及终端才注册 OSC
 * 处理器。主人在浏览器里新建终端、手动敲了几条命令之后才让助手看块表时，
 * 那几条命令的 A/B/C/D 已经过去了，块表会凭空少一截。
 *
 * 这里包装 `controller.create`：浏览器与助手的专属终端都走同一入口，终端一
 * 出生就有跟踪器。包装失败（方法不可写、宿主换了实现）只是退回惰性路径，
 * 不影响终端创建本身。
 * @param controller - TerminalController
 * @returns 是否已安装（或此前已安装）
 */
export function installTrackerHooks(controller) {
  if (controller === undefined || controller === null) return false
  if (controller[TRACKER_HOOKS] === true) return true
  const create = controller.create
  if (typeof create !== 'function') return false
  try {
    controller.create = async function createWithBlockTracker(agent, request, signal) {
      const info = await create.call(this, agent, request, signal)
      try {
        const terminal = this.terminal(agent, info.id)
        if (terminal !== undefined) blockTrackerOf(terminal)
      } catch {
        /* 跟踪器附加失败不能影响终端创建 */
      }
      return info
    }
  } catch {
    return false
  }
  try {
    Object.defineProperty(controller, TRACKER_HOOKS, {
      value: true,
      enumerable: false,
      configurable: true,
    })
  } catch {
    /* 打标记失败也不回滚：包装已经生效，最多热重载时再包一层（幂等） */
  }
  return true
}

/**
 * 专属终端的稳定前缀。真正的终端 id 会带时间戳后缀：宿主 `create` 对已存在
 * 的 id 是幂等的，退出的进程不会被重启；`close` 又会把 id 加入 closedIds，
 * 同一个 id 不能再次创建。因此每次重建都必须换一个新 id。
 */
export function ownTerminalBase(agent) {
  const raw = String(agent?.id ?? 'unknown').replace(/[^\w-]/g, '')
  return `agent-${raw.slice(-24)}`
}

/** 判断一个终端 id 是否属于助手的专属终端（含旧版本的固定 id）。 */
export function isOwnTerminal(agent, id) {
  const base = ownTerminalBase(agent)
  const value = String(id ?? '')
  return value === base || value.startsWith(`${base}-`)
}

/** 进程内递增序号，避免同一毫秒内连续重建时 id 相撞。 */
let ownTerminalSerial = 0

/** 生成一个从未使用过的专属终端 id。 */
function nextOwnTerminalId(agent, list) {
  const base = ownTerminalBase(agent)
  const used = new Set((list ?? []).map((info) => String(info.id)))
  let id
  do {
    ownTerminalSerial += 1
    id = `${base}-${Date.now().toString(36)}-${ownTerminalSerial}`
  } while (used.has(id))
  return id
}

/** 把宿主错误翻译成模型能照着做的说明，同时保留原始原因。 */
function ownTerminalError(error) {
  const detail = error?.message ?? String(error)
  if (error?.code === 'terminal/limit-reached') {
    return new Error(
      `专属终端重建失败：当前会话的终端数已达上限。` +
        `请主人关闭不用的终端标签后重试。原始错误：${detail}`,
    )
  }
  return new Error(`专属终端重建失败：${detail}。请主人检查终端服务后重试，或手动开一个终端。`)
}

/**
 * 确保当前会话有一个可写的专属终端。
 *
 * 旧实现看到 own id 已存在就直接返回；进程退出后 `state=exited`，`create`
 * 又会幂等返回同一个退出实例，于是永远恢复不了。这里改为：
 *   1. 有运行中的专属终端 → 直接复用；
 *   2. 只有退出的旧实例 → 保留记录，先用新 id 创建；
 *   3. 新 id 创建撞上会话终端上限 → 从最旧的专属终端开始逐个释放槽位，
 *      每次关闭后立刻重试创建，成功即停（不做过度清理）。
 * 旧终端记录默认保留，只有确实挡住新终端时才清理。
 *
 * @param controller - 宿主 terminalController
 * @param agent - 会话属主
 * @param signal - 调用方取消信号
 * @returns 运行中的专属终端
 */
export async function ensureOwnTerminal(controller, agent, signal) {
  const list = controller.list(agent.id)
  const own = list.filter((info) => isOwnTerminal(agent, info.id))
  const running = own.filter((info) => info.state === 'running')
  if (running.length > 0) return running[running.length - 1]

  const create = async (current) =>
    await controller.create(
      agent,
      { id: nextOwnTerminalId(agent, current), cols: MY_COLS, rows: MY_ROWS },
      signal,
    )

  try {
    return await create(list)
  } catch (error) {
    /* 只有“终端数已达上限”才值得清理旧实例；其它错误原样抛出，
       否则会把 shell 启动失败误报成清理问题。 */
    if (error?.code !== 'terminal/limit-reached') throw ownTerminalError(error)
    const stale = own.filter((info) => info.state !== 'running')
    if (stale.length === 0) throw ownTerminalError(error)
    /* 逐个释放，创建成功就停：上限只差一个槽位时，没必要把历史记录全删掉。 */
    let lastError = error
    for (const info of stale) {
      try {
        await controller.close(agent, info.id)
      } catch (closeError) {
        console.warn(`[terminal-workbench] 关闭旧专属终端失败：${info.id}`, closeError)
        continue
      }
      try {
        return await create(controller.list(agent.id))
      } catch (retryError) {
        lastError = retryError
        if (retryError?.code !== 'terminal/limit-reached') throw ownTerminalError(retryError)
      }
    }
    throw ownTerminalError(lastError)
  }
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

/**
 * 省略 terminalId 时的默认选择：主人的活跃标签（controllerId 存在） → 仍在运行的 → 最后一个。
 *
 * 最后那层兜底是有意为之：所有终端都已退出时，屏幕里往往还留着刚崩掉的那段报错——
 * 主人说"你看看这个终端"时，读得到比报"没有这个终端"有用得多。
 * （terminal_run / terminal_send 省略 id 时走 ensureOwnTerminal，不经过这里。）
 * @param list - 终端清单
 * @returns 选中的终端，可能 undefined（一个都没有）
 */
function fallbackPick(list) {
  const open = list.filter((info) => info.state === 'running')
  const controlled = open.filter((info) => info.controllerId !== undefined)
  return controlled[controlled.length - 1] ?? open[open.length - 1] ?? list[list.length - 1]
}

/**
 * 定位一个终端：精确 id → 序号（#2 / 2）→ 标题子串 → id 前缀。
 *
 * 为什么需要模糊匹配：终端 id 是 `agent-<24 位后缀>` 这类机器串，模型拿不到清单时
 * 只能瞎猜，猜错再猜错（这是 v0.2.0 里最常见的失败）。而终端标题常常都一样
 * （全是 `zsh`），所以又必须让模型能先"看一眼"。两者配合才是"迅速定位"。
 *
 * 优先级刻意把**精确 id 排在最前**：老调用方式一字不改地继续工作。
 * @param list - 终端清单
 * @param query - 模型给出的定位串；空串/未给表示"我自己看着办"
 * @returns 命中的终端；没命中返回 undefined（由调用方决定怎么报错）
 */
function resolveTerminal(list, query) {
  if (list.length === 0) return undefined
  const text = String(query ?? '').trim()
  if (text === '') return fallbackPick(list)

  const exact = list.find((info) => info.id === text)
  if (exact !== undefined) return exact

  /* 序号：#2 或裸 2。清单顺序就是 terminal_list 展示的顺序，来回不用换算。 */
  const ordinal = text.startsWith('#') ? Number(text.slice(1)) : Number(text)
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= list.length) return list[ordinal - 1]

  const lowered = text.toLowerCase()
  const byTitle = list.filter((info) => String(info.title ?? '').toLowerCase().includes(lowered))
  if (byTitle.length === 1) return byTitle[0]

  const byPrefix = list.filter((info) => String(info.id).startsWith(text))
  if (byPrefix.length === 1) return byPrefix[0]

  return undefined
}

/**
 * 没有命中时给模型的报错：把可读清单一起回过去，让它下一次就能定位对。
 * @param list - 终端清单
 * @param lines - 与 list 同序的可读描述行
 * @param query - 模型原本给的定位串
 * @returns Error
 */
function unknownTerminalError(list, lines, query) {
  if (list.length === 0)
    return new Error('当前会话还没有任何终端：请先省略 terminalId，让我开一个自己的专属终端。')
  const shown = typeof query === 'string' && query.trim() !== '' ? query : '（未指定）'
  return new Error(
    `没有这个终端：${shown}。当前会话的终端是：\n${lines.join('\n')}\n可以用 #序号、标题，或上面列出的 id 来指定。`,
  )
}

/**
 * 判断一次写入是否越界：先把定位串解析成确定的终端，再看是不是自己的专属终端。
 *
 * 为什么必须先解析：模型现在可以用 `#2`、标题片段、id 前缀指认终端，拿原始字符串
 * 跟专属 id 逐字比对的话，`#2` 会因为不等于 `agent-xxx` 而被当成外部终端——明明
 * 指向自己的终端却弹审批，闸门就成了噪音。解析成 id 之后再比，才判得准。
 *
 * 专属终端可能带时间戳后缀（重建后 id 变了），所以用 `isOwnTerminal` 按前缀判断，
 * 不能再用固定 id 相等比较。
 *
 * 解析不出来时返回 undefined（= 不拦）：那种情况工具里会抛出带完整清单的错误，
 * 比弹一个"允许往不存在的终端写入吗"的框有用得多。
 * @param agent - 发起调用的 agent
 * @param list - 当前会话的终端清单
 * @param query - 参数里给出的定位串（可能为空/未给）
 * @returns 越界时返回 { id, title, ordinal }，否则 undefined
 */
function foreignTarget(agent, list, query) {
  if (typeof query !== 'string' || query.trim() === '') return undefined
  const hit = resolveTerminal(list, query)
  if (hit === undefined) return undefined
  if (isOwnTerminal(agent, hit.id)) return undefined
  return { id: hit.id, title: hit.title, ordinal: list.indexOf(hit) + 1 }
}

/**
 * 终端的有效输入权限。
 *
 * 只由两件事决定：终端归属（助手专属 / 外部）和当前会话的 DSH 审批策略。
 * 插件不再保存任何授权记录——DSH 的 `never` 就是"不弹审批、直接允许"，
 * `ask` 就是"逐次问人"。
 * @param agent - 会话属主
 * @param info - 终端元信息
 * @param policy - 当前会话审批策略
 * @returns `{ access, own, reason? }`
 */
function accessOf(agent, info, policy) {
  const own = isOwnTerminal(agent, info.id)
  if (info.state !== 'running') return { access: 'read-only', own, reason: 'exited' }
  if (own) return { access: 'own', own }
  if (policy === 'never') return { access: 'writable', own }
  return { access: 'approval', own }
}

/** 把访问状态翻译成一行中文标记（归属由调用方单独拼接，避免重复）。 */
function accessLabel(value) {
  if (value.own && value.access === 'own') return '可输入'
  if (value.reason === 'exited') return '已退出 · 仅可读'
  if (value.access === 'writable') return '可写'
  if (value.access === 'approval') return '可读 · 写入需审批'
  return '可读'
}

/**
 * 把终端清单压成浏览器/模型共用的访问快照。
 * @param {string} sessionId - 会话 id
 * @param {any[]} list - terminalController.list(sessionId)
 * @param {'ask' | 'never' | undefined} policy
 * @returns 带归属、访问级别与中文标签的数组
 */
export function terminalAccessItems(sessionId, list, policy) {
  const agent = { id: sessionId }
  return (list ?? []).map((info, index) => {
    const access = accessOf(agent, info, policy)
    return {
      ordinal: index + 1,
      id: info.id,
      title: info.title || '未命名',
      state: info.state,
      own: access.own,
      access: access.access,
      ...(access.reason === undefined ? {} : { reason: access.reason }),
      controlled: info.controllerId !== undefined,
      label: accessLabel(access),
    }
  })
}

export function apply(ctx, options = {}) {
  const controller = ctx.terminalController

  /** 读取某个会话当前的审批策略；会话不在线时返回 undefined（UI 只显示未知）。 */
  const policyOfSession = (sessionId) => {
    try {
      const agent = ctx.get('agents')?.get(sessionId)
      return agent === undefined ? undefined : approvalPolicyOf(ctx, agent)
    } catch {
      return undefined
    }
  }

  /* 新终端一出生就挂跟踪器；失败也没关系，下面的 trackAll 会兜底。 */
  installTrackerHooks(controller)

  /**
   * 取内部 PTY 对象。宿主侧**不能**用 `controller.attach()`：
   * 那个方法要求 `ctx.invocation`（浏览器侧的 Remote 双向流），插件上下文里
   * 拿不到，调用即抛 "Terminal attachment requires a Remote invocation"。
   * `terminal()` 是同一份 BrowserTerminal，直接读它的 serializer 就够了。
   * @param agent - 会话属主
   * @param id - 终端身份
   * @returns 内部 PTY（含 screen/serializer/handle）
   */
  function ptyOf(agent, id) {
    const terminal = controller.terminal(agent, id)
    if (terminal === undefined) throw new Error(`拿不到终端：${id}`)
    return terminal
  }

  /**
   * 给会话里已有的终端补齐块跟踪器。
   *
   * `installTrackerHooks` 覆盖新终端；这里兜住两类旧终端：插件热重载前就
   * 已经存在的，以及宿主换了 create 实现导致包装没装上的。任何工具开始
   * 操作终端前调用一次，之后主人手动敲的命令就能进块表。
   * @param agent - 会话属主
   */
  function trackAll(agent) {
    let list
    try {
      list = controller.list(agent.id)
    } catch {
      return
    }
    for (const info of list) {
      try {
        blockTrackerOf(controller.terminal(agent, info.id))
      } catch {
        /* 单个终端失败不影响其它终端 */
      }
    }
  }

  /**
   * 只读快照：直接序列化 xterm 的当前屏幕。
   * 不 attach、不抢输入控制权——主人正在打字时也不会被打断。
   * @param agent - 会话属主
   * @param id - 终端身份
   * @returns 屏幕文本与终端元信息
   */
  async function snapshotOf(agent, id) {
    const terminal = ptyOf(agent, id)
    const screen = typeof terminal.serializer?.serialize === 'function' ? terminal.serializer.serialize() : ''
    return { screen, info: terminal.info }
  }

  /** 屏幕最后一行非空文本的上限：够判断"这个终端在干嘛"，又不至于撑爆上下文。 */
  const LAST_LINE_MAX = 100

  /**
   * 屏幕最后一行非空文本——判断"这个终端现在在干嘛"最快的一眼信息。
   *
   * 为什么需要它：终端标题常常都一样（三个标签全叫 `zsh`），而 `cwd` 是创建时的
   * 初始目录、不随 `cd` 更新（宿主明确注释过）。要区分"哪个是在跑 dev server 的"，
   * 最后一行反而最准。
   *
   * 读屏是纯本地序列化、不写入、不 attach，因此这里**不需要审批**；
   * 单个终端读失败不影响其它行。
   * @param agent - 会话属主
   * @param id - 终端身份
   * @returns 最后一行文本；读不到返回空串
   */
  function lastLineOf(agent, id) {
    try {
      const terminal = controller.terminal(agent, id)
      const screen = typeof terminal?.serializer?.serialize === 'function' ? terminal.serializer.serialize() : ''
      const lines = plainText(screen)
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .filter((line) => line !== '')
      const last = lines[lines.length - 1] ?? ''
      const safe = redactText(last)
      return safe.length > LAST_LINE_MAX ? `…${safe.slice(-LAST_LINE_MAX)}` : safe
    } catch {
      return ''
    }
  }

  /**
   * 把终端清单翻译成模型一眼能读、也能直接拿来定位的文本行。
   *
   * 每行都带上"是不是我的""主人是否正在控制""助手当前能不能输入"：
   * 第一条决定省略 terminalId 时的目标与审批路径，后两条模型以前只能靠猜。
   * @param agent - 会话属主
   * @param list - 终端清单
   * @param policy - 当前会话审批策略
   * @returns 与 list 同序的描述行
   */
  function describeTerminals(agent, list, policy) {
    return list.map((info, index) => {
      const controlled = info.controllerId !== undefined
      const access = accessOf(agent, info, policy)
      const marks = [access.own ? '助手专属' : '外部终端', controlled ? '主人正在用' : null, accessLabel(access)]
        .filter(Boolean)
        .join(' · ')
      const shell = typeof info.shell === 'object' && info.shell !== null ? info.shell.name ?? info.shell.path ?? '' : String(info.shell ?? '')
      const last = lastLineOf(agent, info.id)
      return `#${index + 1} ${info.title || '未命名'}｜id=${info.id}｜${marks}｜${shell}｜${info.state}${last === '' ? '' : `｜最后一行：${last}`}`
    })
  }

  /**
   * 定位一次调用的目标终端；定位不到就抛出带可读清单的错误。
   * @param agent - 会话属主
   * @param query - 模型给出的定位串（可空）
   * @returns 命中的终端
   */
  function targetOf(agent, query) {
    const list = controller.list(agent.id)
    if (list.length === 0) throw new Error('当前会话还没有任何终端，请先省略 terminalId，让我开一个自己的专属终端')
    const hit = resolveTerminal(list, query)
    if (hit === undefined) {
      throw unknownTerminalError(list, describeTerminals(agent, list, approvalPolicyOf(ctx, agent)), query)
    }
    return hit
  }

  /**
   * 写入前的目标校正：专属终端已退出时自动重建；外部终端已退出则明确报错。
   * @param agent - 会话属主
   * @param terminal - 已解析的目标终端
   * @param signal - 调用方取消信号
   * @returns 可写的终端
   */
  async function writableTarget(agent, terminal, signal) {
    if (isOwnTerminal(agent, terminal.id)) {
      if (terminal.state === 'running') return terminal
      return await ensureOwnTerminal(controller, agent, signal)
    }
    if (terminal.state !== 'running') {
      throw new Error(
        `终端「${terminal.title || terminal.id}」状态是 ${terminal.state}，不能写入。` +
          `只读查看请用 terminal_read；外部终端请主人重开后重试。`,
      )
    }
    return terminal
  }

  /**
   * 在指定终端里写一条命令，等它跑完并返回这段时间的输出。
   *
   * 完成判定有两条路：
   *   1. shell 集成（S4 的 OSC 133）就绪时，等本命令的 `D` 标记——退出码、
   *      耗时、输出边界都来自同一份真实信号，`sleep 5` 这种无输出命令也
   *      不会傻等满 30 秒；
   *   2. 没有集成 / 正在 alternate buffer（vim、less）时，退回旧的"屏幕静止"
   *      判定，保持对交互式程序的旧行为。
   *
   * 写入仍走 PTY 底层的 handle.write，和浏览器输入同一条通道，但不需要
   * 持有 attachment 的独占输入权。
   * @param agent - 会话属主
   * @param id - 终端身份
   * @param command - 要执行的命令行（自动补回车）
   * @param timeoutMs - 最长等待毫秒
   * @param signal - 调用方取消信号
   * @returns 原始输出、基线屏幕、是否超时、命中的命令块
   */
  async function runIn(agent, id, command, timeoutMs, signal) {
    const terminal = ptyOf(agent, id)
    if (typeof terminal.handle?.write !== 'function') throw new Error('终端底层不可写：handle.write 不存在')
    const tracker = blockTrackerOf(terminal)
    const seqBefore = tracker?.seq ?? 0
    const baseline = terminal.serializer.serialize()

    /* 命令末尾补 \r（PTY 里回车就是 \r），已经带了就不再补。 */
    signal?.throwIfAborted?.()
    await terminal.handle.write(command.endsWith('\r') ? command : `${command}\r`)

    /* 慢命令放宽静止阈值与时限：默认 30s 对 `npm install` 必然超时。
       但模型显式传的 timeoutMs 一律尊重——它比我们更清楚自己在等什么。 */
    const pacing = pacingFor(command)
    const quietMs = pacing.quietMs
    const effectiveTimeout = timeoutMs === undefined ? pacing.timeoutMs : Math.max(1000, timeoutMs)
    const deadline = Date.now() + Math.max(1000, effectiveTimeout)
    let last = baseline
    let lastChange = Date.now()
    let sawOutput = last !== baseline
    let completed
    while (Date.now() < deadline) {
      await delay(60)
      signal?.throwIfAborted?.()
      const now = terminal.serializer.serialize()
      if (now !== last) {
        last = now
        lastChange = Date.now()
        sawOutput = true
      }
      if (tracker !== undefined) {
        completed = tracker.completedSince(seqBefore)
        if (completed !== undefined) break
      }
      /* 没有"我这条命令"的打开块，或已切到 alternate buffer：沿用静止判定。
         前者是 shell 集成缺席，后者是 vim/less 这类不会回 D 的全屏程序。 */
      const mineOpen = tracker?.open !== undefined && tracker.open.id > seqBefore
      const alternate = bufferOfTerminal(terminal)?.type === 'alternate'
      if ((!mineOpen || alternate) && sawOutput && Date.now() - lastChange > quietMs) break
    }
    /* D 刚到时提示符可能还在重绘；多等一小会儿让屏幕定格，再取快照。 */
    if (completed !== undefined) await delay(80)
    signal?.throwIfAborted?.()
    const screen = terminal.serializer.serialize()
    return {
      output: completed?.output ?? '',
      baseline,
      screen,
      timedOut: completed === undefined && Date.now() >= deadline,
      block: completed,
    }
  }

  /* ---------- 审批闸门：外部终端写入完全跟随 DSH 权限预设 ---------- */

  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!WRITE_TOOLS.has(exec.name)) return next()
        /* 写入前先给已有终端补跟踪器，确保这条命令的 C/D 能被记下来。 */
        trackAll(exec.agent)
        const args = exec.arguments
        const query = typeof args?.terminalId === 'string' ? args.terminalId : ''
        /* 省略定位串 → 用自己的专属终端，不打扰主人 */
        if (query.trim() === '') return next()
        const isRun = exec.name === 'terminal_run'
        const action = isRun ? '执行命令' : '写入按键'

        /* 先把定位串解析成确定的终端：
             - 指向自己的专属终端 → 放行，不弹框；
             - 指向不存在的终端   → 放行，让工具抛出带清单的错误（比弹审批有用）；
             - 指向外部终端       → 按 DSH 审批策略处理；
             - 清单读不到         → 无法确认归属，宁可多问一句。
           只读取列表，不涉及任何写操作。 */
        let list
        try {
          list = ctx.terminalController.list(exec.agent.id)
        } catch {
          list = undefined
        }
        const target = list === undefined ? undefined : foreignTarget(exec.agent, list, query)
        if (list !== undefined && target === undefined) return next()
        /* 审批面板上给主人看的名字：能解析就给「标题」(id)，解析不了就原文照抄。
           主人认得的是"那个在跑 dev server 的标签"，不是 agent- 开头那串机器 id。 */
        const title = target === undefined ? query : target.title || '未命名'
        const zhLabel = target === undefined ? `「${title}」` : `「${title}」(${target.id})`
        const enLabel = target === undefined ? `"${title}"` : `"${title}" (${target.id})`
        const policy = approvalPolicyOf(ctx, exec.agent)

        /* DSH 的 never 预设 = 不弹审批、直接允许（danger-full-access）。
           插件不再有独立授权表，因此这里不需要任何额外判定。 */
        if (policy === 'never') return next()

        const detail =
          isRun && typeof args?.command === 'string' && args.command !== '' ? `：${clip(args.command, 200)}` : ''
        return askForApproval(
          `terminal-workbench: ${exec.name} targets terminal ${enLabel} (not the agent-owned one) — ${action}${detail}`,
          {
            en: `The agent wants to ${isRun ? 'run a command' : 'type'} in terminal ${enLabel}, which is not its own. Allow this once?${detail}`,
            zh: `模型要在终端${zhLabel}里${action}，那不是它自己的终端。当前 DSH 预设需要审批，允许这一次吗？${detail}`,
          },
        )
      }),
    'terminal-workbench: approval gate',
  )

  /* ---------- /terminal-access：只读状态（写入权限跟随 DSH） ---------- */

  /** `/terminal-access` 的用法说明。 */
  function accessUsage() {
    return [
      '用法：',
      '/terminal-access    查看终端访问状态（只读）',
      '',
      '终端写入权限跟随 DSH 权限预设，不再单独授权：',
      '  · full-access（approval=never）：助手可直接写入外部终端，不弹审批；',
      '  · ask 预设：助手写入外部终端时，DSH 会逐次弹出允许/拒绝面板。',
      '助手专属终端始终可写；已退出的终端只能读。',
    ].join('\n')
  }

  /** 终端访问状态清单。 */
  function accessSummary(agent) {
    const list = controller.list(agent.id)
    const policy = approvalPolicyOf(ctx, agent)
    const lines = list.map((info, index) => {
      const access = accessOf(agent, info, policy)
      const controlled = info.controllerId !== undefined ? ' · 正在使用' : ''
      return `#${index + 1} ${info.title || '未命名'}｜id=${info.id}｜${access.own ? '助手专属' : '主人终端'}${controlled}｜${accessLabel(access)}｜${info.state}`
    })
    if (lines.length === 0) lines.push('（当前会话还没有终端）')
    const note =
      policy === 'never'
        ? '当前预设不弹审批：助手可直接写入外部终端（等同于 DSH 的 full-access）。'
        : policy === 'ask'
          ? '当前预设需要审批：助手写入外部终端时会由 DSH 逐次询问。'
          : '当前无法读取 DSH 审批策略：助手写入外部终端时会按需请求审批（fail-closed）。'
    return [`当前会话终端访问（审批策略：${policy ?? '未知'}）`, ...lines, note, '', accessUsage()].join('\n')
  }

  /* 权限跟随 DSH 后不再有 grant/revoke；保留命令只为查看状态。 */
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'terminal-access',
      description: '查看助手对终端访问状态（写入权限跟随 DSH 权限预设）',
      input: { hint: '[status|help]' },
      handler: ({ agent, rawInput }) => {
        const parts = String(rawInput ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
        const verb = (parts[0] ?? '').toLowerCase()
        if (verb === '' || verb === 'list' || verb === 'status') return { kind: 'success', text: accessSummary(agent) }
        if (verb === 'help') return { kind: 'success', text: accessUsage() }
        if (verb === 'grant' || verb === 'revoke') {
          return {
            kind: 'error',
            text: `终端写入权限已改为跟随 DSH 权限预设，不再需要单独${verb === 'grant' ? '授权' : '撤销'}。\n${accessUsage()}`,
          }
        }
        return { kind: 'error', text: `未知子命令：${parts[0]}\n${accessUsage()}` }
      },
    })
  })

  /* ---------- terminal_list：先"看一眼"，才谈得上迅速定位 ---------- */

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'terminal_list',
        description:
          '列出当前会话里所有终端：#序号、标题、id、归属（助手专属 / 主人终端）、访问权限（own / writable / approval / read-only）、shell、状态，以及屏幕最后一行（判断它在干嘛最快的一眼信息）。只读、不需要审批——要操作哪张终端之前先调它，再用 #序号 或 id 定位。终端写入权限跟随 DSH 权限预设：full-access（never）下外部终端可写，ask 下写入会请求审批。助手专属终端退出后，下一次 terminal_run 会自动重建。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              ownTerminalId: { type: 'string' },
              terminals: { type: 'string' },
              access: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ordinal: { type: 'number' },
                    id: { type: 'string' },
                    title: { type: 'string' },
                    own: { type: 'boolean' },
                    access: { type: 'string', enum: ['own', 'writable', 'approval', 'read-only'] },
                    reason: { type: 'string', enum: ['exited'] },
                  },
                  required: ['ordinal', 'id', 'title', 'own', 'access'],
                  additionalProperties: false,
                },
              },
            },
            required: ['count', 'ownTerminalId', 'terminals', 'access'],
            additionalProperties: false,
          },
          render: (_args, value) =>
            textBlocks(
              `当前会话共 ${value?.count ?? 0} 个终端（我的专属：${value?.ownTerminalId || '未运行，下次 terminal_run 会自动创建或重建'}）\n${value?.terminals ?? ''}`,
            ),
        },
        async execute(_args, exec) {
          trackAll(exec.agent)
          const list = ctx.terminalController.list(exec.agent.id)
          const policy = approvalPolicyOf(ctx, exec.agent)
          const items = terminalAccessItems(exec.agent.id, list, policy).map((item) => ({
            ordinal: item.ordinal,
            id: item.id,
            title: item.title,
            own: item.own,
            access: item.access,
            ...(item.reason === undefined ? {} : { reason: item.reason }),
          }))
          const ownRunning = list
            .filter((info) => isOwnTerminal(exec.agent, info.id) && info.state === 'running')
            .pop()
          const external = list.filter((info) => !isOwnTerminal(exec.agent, info.id))
          let footer = ''
          if (external.length > 0) {
            footer =
              policy === 'never'
                ? '\n当前 DSH 预设为 full-access（approval=never）：助手可直接写入外部终端，不弹审批。'
                : policy === 'ask'
                  ? '\n当前 DSH 预设需要审批：助手写入外部终端时，DSH 会逐次弹出允许/拒绝面板。'
                  : '\n当前无法读取 DSH 审批策略：助手写入外部终端时会按需请求审批（fail-closed）。'
          }
          const ownExited = list.some((info) => isOwnTerminal(exec.agent, info.id) && info.state !== 'running')
          if (ownExited) footer += '\n提示：助手专属终端有已退出的旧实例；直接省略 terminalId 调用 terminal_run 会自动重建。'
          return {
            count: list.length,
            ownTerminalId: ownRunning?.id ?? '',
            terminals: describeTerminals(exec.agent, list, policy).join('\n') + footer,
            access: items,
          }
        },
      }),
    'terminal-workbench: tool terminal_list',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'terminal_run',
        description:
          '在我的专属终端里执行一条命令并返回输出。默认不碰主人的终端；专属终端退出后会自动重建。terminalId 可以写 #序号 / 标题片段 / id 前缀，指向别的终端时按 DSH 权限预设处理：full-access（approval=never）直接执行，ask 预设请求审批。不确定当前有哪些终端，先调 terminal_list 看一眼。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令，回车会自动补上。' },
            timeoutMs: {
              type: 'number',
              description: `最长等待毫秒；不传时按命令特征决定（装包/拉镜像/编译这类慢命令自动放宽到 ${Math.round(SLOW_TIMEOUT_MS / 1000)} 秒，其余 ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} 秒）。超时也会返回已有输出。`,
            },
            terminalId: {
              type: 'string',
              description:
                '可选：目标终端。#序号（如 #2）、标题片段、id 前缀都认，terminal_list 列出的 id 可直接用；省略则用我自己的专属终端（已退出会自动重建）。指向外部终端时按 DSH 权限预设处理：never 直接执行，ask 请求审批。',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              terminalId: { type: 'string' },
              output: { type: 'string' },
              screen: { type: 'string' },
              timedOut: { type: 'boolean' },
              blockId: { type: 'number' },
              exitCode: { type: 'number' },
              durationMs: { type: 'number' },
              cwd: { type: 'string' },
            },
            required: ['terminalId', 'output', 'screen', 'timedOut'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const marks = []
            if (Number.isFinite(value?.exitCode)) marks.push(`退出码 ${value.exitCode}`)
            if (Number.isFinite(value?.durationMs)) marks.push(`耗时 ${formatDuration(value.durationMs)}`)
            const suffix = marks.length > 0 ? `（${marks.join('，')}）` : ''
            const head = `[终端 ${value?.terminalId ?? '?'}]${suffix}${value?.timedOut ? '（等待超时，以下为已有输出）' : ''}`
            /* 优先回**增量**（output），而不是整屏。
               整屏每次都把历史重背一遍，模型多调几次上下文就爆了；
               output 优先取 OSC 133 块的精确输出，没有块时退回 screenDelta。 */
            const delta = typeof value?.output === 'string' ? value.output.trim() : ''
            const full = typeof value?.screen === 'string' ? value.screen.trim() : ''
            const text = delta !== '' ? delta : full
            return textBlocks(`${head}\n${text === '' ? '（无输出）' : text}`)
          },
        },
        presentCall: (args) => ({
          card: 'terminal',
          title: typeof args?.command === 'string' ? args.command : 'terminal_run',
        }),
        async execute(args, exec) {
          trackAll(exec.agent)
          const command = String(args?.command ?? '')
          if (command.trim() === '') throw new Error('command 不能为空')
          /* 不给默认值：留给 runIn 按命令特征决定（慢命令自动放宽）。 */
          const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : undefined
          let terminal
          if (typeof args?.terminalId === 'string' && args.terminalId.trim() !== '') {
            terminal = targetOf(exec.agent, args.terminalId)
          } else {
            terminal = await ensureOwnTerminal(controller, exec.agent, exec.signal)
          }
          terminal = await writableTarget(exec.agent, terminal, exec.signal)
          const { baseline, screen, timedOut, block } = await runIn(
            exec.agent,
            terminal.id,
            command,
            timeoutMs,
            exec.signal,
          )
          const finalScreen = plainText(screen)
          /* 有精确块就用块输出；没有 shell 集成时退回整屏差集。 */
          const delta = baseline !== '' ? screenDelta(baseline, screen) : finalScreen
          const raw = block === undefined ? delta : block.output
          const durationMs = block === undefined ? undefined : block.endedAt - block.startedAt
          return {
            terminalId: terminal.id,
            output: clip(String(raw ?? '').replace(/^\n+/, '')),
            screen: clip(finalScreen),
            timedOut,
            ...(block === undefined ? {} : { blockId: block.id }),
            ...(Number.isFinite(block?.exitCode) ? { exitCode: block.exitCode } : {}),
            ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
            ...(typeof block?.cwd === 'string' && block.cwd !== '' ? { cwd: block.cwd } : {}),
          }
        },
      }),
    'terminal-workbench: tool terminal_run',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'terminal_send',
        description:
          '往终端原样写入文本（不加回车），用于交互式程序、ssh、vim 等需要按键序列的场景。默认写入我的专属终端；专属终端退出后会自动重建。terminalId 可以写 #序号 / 标题片段 / id 前缀，指向别的终端时按 DSH 权限预设处理：full-access（approval=never）直接执行，ask 预设请求审批。不确定目标就先调 terminal_list。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要写入的原始文本；控制字符请自行给出（如 \\u0003 表示 Ctrl+C）。' },
            waitMs: { type: 'number', description: '写入后等待多久再读屏幕，默认 800 毫秒。' },
            terminalId: {
              type: 'string',
              description:
                '可选：目标终端。#序号（如 #2）、标题片段、id 前缀都认，terminal_list 列出的 id 可直接用；省略则用我的专属终端（已退出会自动重建）。指向外部终端时按 DSH 权限预设处理：never 直接执行，ask 请求审批。',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              terminalId: { type: 'string' },
              screen: { type: 'string' },
            },
            required: ['terminalId', 'screen'],
            additionalProperties: false,
          },
          render: (_args, value) => textBlocks(`[终端 ${value?.terminalId ?? '?'}]\n${value?.screen ?? ''}`),
        },
        async execute(args, exec) {
          trackAll(exec.agent)
          const text = String(args?.text ?? '')
          const waitMs = Number.isFinite(args?.waitMs) ? Number(args.waitMs) : 800
          let terminal
          if (typeof args?.terminalId === 'string' && args.terminalId.trim() !== '') {
            terminal = targetOf(exec.agent, args.terminalId)
          } else {
            terminal = await ensureOwnTerminal(controller, exec.agent, exec.signal)
          }
          terminal = await writableTarget(exec.agent, terminal, exec.signal)
          /* 原样写入，不补回车——交互式程序（vim/ssh）要的正是裸按键。
             走 PTY 底层通道，不 attach，因此不抢主人的输入控制权。 */
          const pty = ptyOf(exec.agent, terminal.id)
          if (typeof pty.handle?.write !== 'function') throw new Error('终端底层不可写：handle.write 不存在')
          await pty.handle.write(text)
          await delay(Math.max(100, waitMs))
          const { screen } = await snapshotOf(exec.agent, terminal.id)
          return { terminalId: terminal.id, screen: clip(screen) }
        },
      }),
    'terminal-workbench: tool terminal_send',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'terminal_read',
        description:
          '只读查看某个终端的屏幕内容（不写入任何输入，因此不需要审批）。用于主人说“你看看这个终端”“帮我分析这个报错”时。不确定是哪张就先调 terminal_list。',
        parameters: {
          type: 'object',
          properties: {
            terminalId: {
              type: 'string',
              description:
                '可选：目标终端。#序号（如 #2）、标题片段、id 前缀都认；省略则取主人正在控制的那张（再退而取最近仍在运行的）。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              terminalId: { type: 'string' },
              title: { type: 'string' },
              state: { type: 'string' },
              screen: { type: 'string' },
            },
            required: ['terminalId', 'title', 'state', 'screen'],
            additionalProperties: false,
          },
          render: (_args, value) => textBlocks(`[终端 ${value?.title ?? value?.terminalId ?? '?'}]\n${value?.screen ?? ''}`),
        },
        async execute(args, exec) {
          trackAll(exec.agent)
          const terminal = targetOf(exec.agent, args?.terminalId)
          const { screen } = await snapshotOf(exec.agent, terminal.id)
          return {
            terminalId: terminal.id,
            title: terminal.title,
            state: terminal.state,
            screen: clip(screen),
          }
        },
      }),
    'terminal-workbench: tool terminal_read',
  )


  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'terminal_blocks',
        description:
          '列出某个终端最近的命令块（命令、状态、退出码、耗时、输出）。数据来自 S4 的 OSC 133 shell 集成，和浏览器里看到的边距块是同一份标记；terminal_run 执行过的命令也会进块表。只读、不需要审批。若终端没有启用 shell 集成，块表为空，请改用 terminal_read 看屏幕。',
        parameters: {
          type: 'object',
          properties: {
            terminalId: {
              type: 'string',
              description:
                '可选：目标终端。#序号（如 #2）、标题片段、id 前缀都认；省略则取主人正在控制的那张（再退而取最近仍在运行的）。',
            },
            limit: {
              type: 'number',
              description: '最多返回多少个块，默认 10，上限 50；最新的块排在最前。',
            },
            includeOutput: {
              type: 'boolean',
              description: '是否返回每块的输出，默认 true；只要命令与退出码时可设 false。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              terminalId: { type: 'string' },
              title: { type: 'string' },
              terminalState: { type: 'string' },
              total: { type: 'number' },
              blocks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    command: { type: 'string' },
                    state: { type: 'string', enum: ['ok', 'fail', 'running', 'unknown'] },
                    exitCode: { type: 'number' },
                    durationMs: { type: 'number' },
                    cwd: { type: 'string' },
                    output: { type: 'string' },
                  },
                  required: ['id', 'command', 'state', 'output'],
                  additionalProperties: false,
                },
              },
            },
            required: ['terminalId', 'title', 'terminalState', 'total', 'blocks'],
            additionalProperties: false,
          },
          render: (args, value) => {
            const total = Number(value?.total ?? 0)
            const list = Array.isArray(value?.blocks) ? value.blocks : []
            const header = `[终端 ${value?.title || value?.terminalId || '?'}] 共 ${total} 个命令块` +
              (list.length < total ? `，显示最近 ${list.length} 个` : '')
            if (list.length === 0) {
              return textBlocks(
                `${header}\n（还没有命令块：该终端未启用 OSC 133 shell 集成，或集成脚本尚未加载。可用 terminal_read 查看屏幕。）`,
              )
            }
            const lines = [header]
            for (const block of list) {
              const meta = [block.state]
              if (Number.isFinite(block.exitCode)) meta.push(`退出码 ${block.exitCode}`)
              if (Number.isFinite(block.durationMs)) meta.push(`耗时 ${formatDuration(block.durationMs)}`)
              if (typeof block.cwd === 'string' && block.cwd !== '') meta.push(block.cwd)
              lines.push('')
              lines.push(`#${block.id} ${meta.join(' · ')} · ${block.command || '（命令未知）'}`)
              if (typeof block.output === 'string' && block.output !== '') lines.push(block.output)
              else if (block.state === 'running') lines.push('（执行中，暂无输出）')
            }
            if (args?.includeOutput === false) lines.push('', '（已按 includeOutput=false 省略输出。）')
            return textBlocks(clip(lines.join('\n')))
          },
        },
        async execute(args, exec) {
          trackAll(exec.agent)
          const terminal = targetOf(exec.agent, args?.terminalId)
          const pty = ptyOf(exec.agent, terminal.id)
          const tracker = blockTrackerOf(pty)
          const all = tracker?.all() ?? []
          const requested = Number.isFinite(args?.limit) ? Math.floor(Number(args.limit)) : 10
          const limit = Math.max(1, Math.min(50, requested))
          const selected = all.slice(Math.max(0, all.length - limit)).reverse()
          const includeOutput = args?.includeOutput !== false
          /* 每块输出共享一份预算，避免 50 个块把上下文一次撑爆。 */
          const perBlock = Math.max(80, Math.floor(MAX_RETURN_CHARS / Math.max(1, selected.length)))
          const now = Date.now()
          const buffer = bufferOfTerminal(pty)
          const blocks = selected.map((block) => {
            const durationMs = block.endedAt === undefined ? now - block.startedAt : block.endedAt - block.startedAt
            let text = ''
            if (includeOutput) {
              if (block.endedAt === undefined) {
                const start =
                  typeof block.outputMarker?.line === 'number' ? block.outputMarker.line : block.outputStartLine
                text = extractBufferRange(buffer, start, cursorLineOf(buffer))
              } else {
                text = block.output ?? ''
              }
              text = clip(text, perBlock)
            }
            return {
              id: block.id,
              command: block.command,
              state: blockStateOf(block),
              ...(Number.isFinite(block.exitCode) ? { exitCode: block.exitCode } : {}),
              ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
              ...(typeof block.cwd === 'string' && block.cwd !== '' ? { cwd: block.cwd } : {}),
              output: text,
            }
          })
          return {
            terminalId: terminal.id,
            title: terminal.title || '未命名',
            terminalState: terminal.state,
            total: all.length,
            blocks,
          }
        },
      }),
    'terminal-workbench: tool terminal_blocks',
  )

  /* 浏览器侧只读状态快照：写入权限跟随 DSH，插件不提供任何授权/撤销入口。 */
  ctx.inject(['webServer'], (webCtx) => {
    registerTerminalAccessApi(webCtx, {
      controller,
      policyOf: policyOfSession,
      itemsOf: (sessionId, list, policy) => terminalAccessItems(sessionId, list, policy),
    })
  })

  console.log(
    '[terminal-workbench] 终端工具已注册：terminal_list（只读定位） / terminal_run / terminal_send / terminal_read / terminal_blocks（只读命令块）（跨终端写入跟随 DSH 权限预设）',
  )
}
