/**
 * dsh-terminal-workbench — host 半侧。
 *
 * 主职责仍然在浏览器半侧（client.js）：三栏布局 + 自绘 xterm。
 * 这里只加一件事：**重启后自动续话**。
 *
 * 背景：`dsh-restart --continue` 先写标记文件再重启服务；重启会杀掉承载当前
 * 轮次的进程，浏览器里那句"继续"没人来敲。与其去操纵浏览器（CDP 被 Chrome
 * 默认 profile 禁掉、URL 参数被 token 重定向丢掉、Wayland 下 xdotool 摸不到
 * 窗口——三条路都试过），不如让宿主自己往会话里送一条用户消息：
 * `sessionController.prompt` 的 `resolveAgent` 能把已落盘的会话重新拉起来，
 * 不要求浏览器在线。
 *
 * 实现：轮询 `~/.dsh/pending-continue.json`（`{ sessionId, text }`）→ 读到就删
 * → 调 `sessionController.prompt`。启动先查一次，因此重启排程的续话立刻生效。
 *
 * 另有一件事是 v0.2.0 补上的**救命逻辑**（见 rescueOnBoot）：本插件的补丁层会
 * 无条件禁用内置 `ui-layout`，一旦浏览器半侧加载失败，整个 Web UI 就没有 root
 * 槽的注册者，只能看到白屏、连插件管理页都进不去——那正是唯一能关掉本插件的
 * 地方。所以宿主在启动后盯住浏览器半侧是否真的加载成功；没成功就自动把补丁
 * 还原成开启内置布局，让人能进设置把插件修好。每次插件实例最多自救一次：
 * 自救后本插件已被禁用，不会形成"自动还原 ↔ 手动启用"的拉锯。
 *
 * @module dsh-terminal-workbench
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-terminal-workbench'

/**
 * 会话控制器是宿主服务（`super(ctx, "sessionController", { namespace: "session" })`）。
 * 必须用模块级 inject 声明：Cordis 禁止在未声明的上下文里读服务属性，而
 * `ctx.inject()` 的回调作用域在返回后会被回收（定时器会被连带清理）。
 */
import * as agentTerminal from './agent-terminal.js'
import { ForwardManager } from './forward.js'
import * as forwardTools from './forward-tools.js'
import { registerFsApi } from './fs-api.js'
import { registerCameraApi } from './camera-api.js'
import { wrapFileSystem } from './remote-fs.js'
import * as remoteFsTools from './remote-fs-tools.js'

export const inject = ['sessionController', 'fs']

/** 续话标记：由 `dsh-restart --continue` 写入。 */
const MARKER = path.join(os.homedir(), '.dsh', 'pending-continue.json')

/** 退回轮询时的间隔：秒级足够。 */
const POLL_MS = 2000
/** 事件模式下的低频安全网：fs.watch 在容器/网络盘上可能漏事件，留一道兜底。 */
const SAFETY_MS = 30000

/** 单次送达的超时：会话恢复流程可能长时间挂起，超时要显式报错而不是静默卡住。 */
const DELIVER_TIMEOUT_MS = 20000

/* ---------- 救命逻辑：浏览器半侧加载失败时自动还原布局补丁 ---------- */

/**
 * 自救时要把补丁层里被本插件禁用的内置条目改回启用。
 *
 * `ui-layout` 是 root 槽唯一的注册者，禁用后若本插件的浏览器半侧没能加载，
 * `RootOutlet` 拿不到任何注册就抛 SlotAssemblyError —— 白屏，而且进不去插件
 * 管理页（那是 main 槽里的一个面板）。`ui-sidebar-terminal` 是内置终端：
 * 自救会禁用本插件，若不把它一并还原，恢复出来的内置布局就没有终端。
 *
 * 只在“禁用本插件”的自救路径里还原这两项；正常重试本插件时仍保留禁用，
 * 避免出现双重终端。
 */
const RESCUE_RESTORES = ['ui-layout', 'ui-sidebar-terminal']

/**
 * 还原布局时必须一并禁用的条目：本插件自身。
 *
 * 只把 `ui-layout` 改回启用而不禁用本插件，会留下"两个 root 槽注册者"的
 * 致命混合态：下次启动时客户端两个 entry 都注册 `root`，后者直接抛
 * `single slot "root" already has a registration at priority 0`，整页白屏。
 * v0.9.0 之前只还原前者，2026-11-07 的事故就是这么来的。
 */
const RESCUE_DISABLES = ['terminal-workbench']

/** 原始补丁备份：首次启动时写一份，之后只在"打开布局"时用。 */
const ORIGINAL_FILE = 'ui-layout.original.yml'

/** profile 用户补丁的原始备份（自救可能同时改 bundle 补丁与 profile 补丁）。 */
const PROFILE_ORIGINAL_FILE = 'profile-patch.original.yml'

/** 宿主启动后至少等这么久，才允许看门狗判定失败。
 *  冷启动时浏览器要拉 10MB 级的客户端包，45 秒容易误判；放宽到 2 分钟。 */
const BOOT_GRACE_MS = 120000

/** 客户端加载静默多久才判定失败。
 *
 *  只看“第一次请求之后 20 秒”不够：冷启动要拉 10MB 级客户端包，慢机器上
 *  请求之间可能间隔很久，20 秒固定宽限会把“还在加载”误判成“加载失败”
 *  （2026-11-08 08:17 事故）。改为看最后一次客户端加载活动：只要还有资源
 *  请求在途，或最后一次请求开始/结束还没超过这个静默期，就继续等。 */
const CLIENT_IDLE_MS = 60000

/** 单个客户端资源请求的最长寿命。
 *
 *  “在途请求”是慢启动的保护伞，但一个真正挂死的请求（客户端已断开、TCP
 *  半开、代理卡住）会让看门狗永远等下去。超过这个时间就不再算在途，
 *  让自救仍然有机会发生。5 分钟远大于正常 10MB 包的下载时间。 */
const INFLIGHT_MAX_MS = 300000

/** 看门狗轮询间隔：只有“有人开页面”后才会真正动作。 */
const WATCHDOG_TICK_MS = 5000

/** 状态目录里的这个文件存在时，关闭自动自救（给高级用户留的开关）。 */
const RESCUE_DISABLED_FILE = 'rescue.disabled'

/** 单调时钟（毫秒）：系统时间跳变不会影响静默期判定。 */
const monotonicNow = () => performance.now()

/**
 * 找出本插件的状态目录基址。
 *
 * 插件从 profile 的 `node_modules` 里被加载，因此自身路径形如
 * `<profile>/node_modules/<包名>/lib/index.js`；向上找到第一个不带
 * `node_modules` 段、且带 `cordis.patch.yml` 的目录就是 profile 根。
 *
 * 陷阱：本包自己也带一份 `cordis.patch.yml`（bundle 补丁）。link 安装时
 * 包目录不在 `node_modules` 下，会停在这里——这是历史行为，书签/远端/
 * 自救备份一直放在包目录的 `.dsh-terminal-workbench/`，不能随便改。
 * @returns {string | undefined} 状态目录基址
 */
function findProfileDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    if (!dir.split(path.sep).includes('node_modules') && fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 找出 profile 根目录（用户补丁层所在的那一层）。
 *
 * 与 {@link findProfileDir} 不同：link 安装时 `findProfileDir` 会停在插件目录
 * （插件目录自己带 bundle 补丁），而 profile 根还要再上一层。这里用
 * `cordis.yml` 作为标记——只有 profile 根同时有 `cordis.yml` 与
 * `cordis.patch.yml`，插件目录没有 `cordis.yml`。
 * @param {string} startDir 起始目录（通常是插件包目录）
 * @returns {string | undefined} profile 根目录
 */
function findProfileRoot(startDir) {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'cordis.yml')) && fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 解析本插件自己的 bundle 补丁路径。
 *
 * 补丁声明在 package.json 的 `dsh.bundle.patch` 里，路径相对包目录；正常情况
 * 就是 `<包目录>/cordis.patch.yml`。不能用 `findProfileDir()` 的结果：npm 安装
 * 时那会指向 profile 根，而 `ui-layout` / `ui-sidebar-terminal` 的条目在包自己
 * 的 bundle 补丁里，改 profile 补丁根本命中不了。
 * @param {string} packageDir 插件包目录
 * @returns {string} bundle 补丁的绝对路径
 */
function resolveBundlePatchPath(packageDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const declared = manifest?.dsh?.bundle?.patch
    if (typeof declared === 'string') return path.resolve(packageDir, declared)
    if (Array.isArray(declared) && typeof declared[0] === 'string') return path.resolve(packageDir, declared[0])
  } catch {
    /* 读不到清单就退回约定路径 */
  }
  return path.join(packageDir, 'cordis.patch.yml')
}

/**
 * 在补丁层里把本插件插入时一并禁用的内置插件改回启用。
 *
 * 补丁层是顶层 YAML 数组，形如 `- id: ui-layout` / `  disabled: true`。
 * 这里只做最小改动：把命中的 `disabled: true` 改成 `false`，其它行原样保留。
 * @param {string} text 补丁文件原文
 * @param {string[]} ids 需要改回启用的插件 id
 * @returns {string} 改写后的文本（无命中时原文返回）
 */
export function restoreEntries(text, ids) {
  const lines = text.split('\n')
  let current
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const idMatch = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      current = idMatch[1].replace(/^["']|["']$/g, '')
      continue
    }
    if (current !== undefined && ids.includes(current) && /^\s*disabled:\s*true\s*$/.test(line)) {
      lines[index] = line.replace(/true\s*$/, 'false')
      changed = true
    }
  }
  return changed ? lines.join('\n') : text
}

/**
 * 在补丁层里把指定条目改为禁用（`disabled: true`）。
 *
 * 与 {@link restoreEntries} 相反：这里保证条目最终处于禁用状态——
 *   - 已有 `disabled: true`：原样保留；
 *   - 已有 `disabled: false`：改成 `true`；
 *   - 没有 `disabled` 键：紧跟在 `- id:` 后补一行（缩进与同级键对齐）。
 *
 * 只按 `- id:` 行定位、不解析完整 YAML：补丁层由本插件自己维护，结构稳定；
 * 这样也不会碰坏注释、引号与 `!!js` 表达式。
 * @param {string} text 补丁文件原文
 * @param {string[]} ids 需要禁用的插件 id
 * @returns {string} 改写后的文本（无命中时原文返回）
 */
export function disableEntries(text, ids) {
  const lines = text.split('\n')
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(lines[index])
    if (idMatch === null) continue
    const id = idMatch[2].replace(/^["']|["']$/g, '')
    if (!ids.includes(id)) continue

    const baseIndent = idMatch[1].length
    let found = false
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      const indent = /^\s*/.exec(line)[0].length
      /* 缩进回退到条目本身或更外层：当前条目结束。 */
      if (indent <= baseIndent) break
      if (/^\s*disabled:\s*/.test(line)) {
        found = true
        if (!/^\s*disabled:\s*true\s*$/.test(line)) {
          lines[cursor] = line.replace(/^(\s*)disabled:.*$/, '$1disabled: true')
          changed = true
        }
        break
      }
    }
    if (!found) {
      /* 紧跟在 `- id:` 后补键，缩进与同级键对齐；不碰条目里已有的其它键。 */
      lines.splice(index + 1, 0, `${idMatch[1]}  disabled: true`)
      changed = true
      index += 1
    }
  }
  return changed ? lines.join('\n') : text
}

/**
 * 判断一个请求是否代表“浏览器正在尝试加载界面”。
 *
 * 看门狗不能把任意带浏览器 UA 的请求都算数：页面已经开着时，旧页面的 API
 * 轮询同样带浏览器 UA，会把“没人重新加载界面”误判成“客户端加载失败”。
 * 只认两类请求：
 *   - 文档导航（`sec-fetch-mode: navigate`，或 GET + `Accept: text/html`）；
 *   - 客户端静态资源（`/assets/`、`/plugins/`）。
 * 探活请求、boot.gif 报到和本插件自己的 API 都不算失败信号。
 * @param {any} req Node HTTP 请求（只读 headers / url / method）
 * @returns {boolean} 是否算一次“尝试加载界面”
 */
export function isClientLoadRequest(req) {
  const headers = req?.headers ?? {}
  if (headers['x-dsh-terminal-workbench-probe'] === '1') return false
  const ua = String(headers['user-agent'] ?? '')
  if (!/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)) return false

  const pathname = String(req?.url ?? '').split('?')[0]
  if (pathname.startsWith('/__dsh-terminal-workbench/')) return false
  if (pathname.startsWith('/assets/') || pathname.startsWith('/plugins/')) return true

  const mode = String(headers['sec-fetch-mode'] ?? '').toLowerCase()
  if (mode === 'navigate') return true
  const accept = String(headers.accept ?? '')
  return (req?.method ?? 'GET') === 'GET' && /text\/html/i.test(accept)
}

/**
 * 看门狗判定：现在是否应该执行自救。
 *
 * 纯函数，时间全部由调用方传入，便于回归测试。全部条件成立才救：
 *   1. 浏览器半侧还没报到；
 *   2. 请求监听已挂上（挂不上时宁可不救，也不误改补丁）；
 *   3. 确实见过浏览器加载界面的请求（没人开页面不算失败）；
 *   4. 没有仍在下载/加载的客户端资源（慢启动期间不能误判）；
 *   5. 宿主启动已超过 `bootGraceMs`；
 *   6. 客户端加载活动已静默 `clientIdleMs`（从最后一次请求开始或结束算起）。
 *
 * 第 4、6 条是 v0.9.3 的关键：固定“首次请求后 20 秒”会把冷启动时仍在
 * 下载大包的浏览器判死；只要请求还在来、或还有请求没结束，就继续等。
 * @param {object} state
 * @returns {boolean}
 */
export function shouldRescue({
  loadedByClient = false,
  browserRequestWatch = false,
  sawBrowserRequest = false,
  now = Date.now(),
  bootedAt = 0,
  lastActivityAt = 0,
  inFlight = 0,
  bootGraceMs = BOOT_GRACE_MS,
  clientIdleMs = CLIENT_IDLE_MS,
} = {}) {
  if (loadedByClient) return false
  if (!browserRequestWatch) return false
  if (!sawBrowserRequest) return false
  if (inFlight > 0) return false
  if (now - bootedAt < bootGraceMs) return false
  if (lastActivityAt === 0) return false
  return now - lastActivityAt >= clientIdleMs
}

/**
 * 统计仍在合理寿命内的在途请求。
 *
 * 纯函数，便于回归测试。超过 `maxAgeMs` 的请求视为挂死：它可能永远不触发
 * `finish`/`close`，不能再当作“客户端还在加载”的证据。
 * @param {Map<any, number>} requests 请求 → 开始时间（单调毫秒）
 * @param {number} now 当前单调毫秒
 * @param {number} [maxAgeMs] 单个请求的最长寿命
 * @returns {number} 活跃在途请求数
 */
export function countActiveRequests(requests, now, maxAgeMs = INFLIGHT_MAX_MS) {
  if (!(requests instanceof Map)) return 0
  let active = 0
  for (const startedAt of requests.values()) {
    if (now - startedAt < maxAgeMs) active += 1
  }
  return active
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 补丁文件是自救的唯一出口，写到一半崩溃会留下半截 YAML，下次启动直接
 * 解析失败。rename 在同文件系统内是原子的，至少保证“旧文件或新文件”二选一。
 * @param {string} file 目标文件
 * @param {string} text 新内容
 */
function writeFileAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let mode
  try {
    mode = fs.statSync(file).mode
  } catch {
    /* 目标不存在（如首次写备份）：用默认权限 */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, mode === undefined ? undefined : { mode })
    fs.renameSync(temp, file)
  } finally {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/**
 * 启动时的自救检查。
 *
 * 时序：宿主先起 → 浏览器随后加载半侧并报到。因此这里不能立刻判断，
 * 要等一个宽限期。宽限期过后仍没报到，还要排除“服务根本没起来/没人开浏览器”
 * 这种正常情况。
 *
 * v0.9.2 起看门狗按“事件”而不是“进程启动”判定；v0.9.3 把固定宽限期改成
 * “加载静默期”；v0.9.4 再补四个洞：
 *   - 挂死的在途请求不再永久阻塞自救（`INFLIGHT_MAX_MS`）；
 *   - 判定与写入之间二次确认，客户端刚报到时绝不误禁用；
 *   - 补丁原子写入，崩溃不会留下半截 YAML；
 *   - 去掉永远走不到的“两次就停”计数（自救后插件已禁用，不会拉锯）。
 * @param {any} ctx 插件上下文
 */
function rescueOnBoot(ctx) {
  const profileDir = findProfileDir()
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const profileRoot = findProfileRoot(packageDir) ?? profileDir
  if (profileDir === undefined || profileRoot === undefined) {
    console.log('[terminal-workbench] 找不到 profile 目录，跳过启动自救检查')
    return
  }
  const stateDir = path.join(profileDir, '.dsh-terminal-workbench')
  const bundlePatchPath = resolveBundlePatchPath(packageDir)
  const profilePatchPath = path.join(profileRoot, 'cordis.patch.yml')
  const bootedAt = monotonicNow()

  /* 高级用户开关：不想让看门狗动补丁时，放一个 rescue.disabled 文件。 */
  if (fs.existsSync(path.join(stateDir, RESCUE_DISABLED_FILE))) {
    console.log(`[terminal-workbench] 检测到 ${RESCUE_DISABLED_FILE}，跳过启动自救看门狗`)
    return
  }

  let busy = false
  let finished = false
  let timer

  /* 新实例从零开始观察：上一次插件实例留下的请求不能算到这一次头上。 */
  sawBrowserRequest = false
  lastBrowserRequestAt = 0
  clientRequestsInFlight = new Map()

  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    if (watchdogTimer === timer) watchdogTimer = undefined
    timer = undefined
  }

  /** 清掉已挂死的在途请求，返回仍活跃的请求数。 */
  const activeInFlight = (now) => {
    for (const [res, startedAt] of clientRequestsInFlight) {
      if (now - startedAt >= INFLIGHT_MAX_MS) clientRequestsInFlight.delete(res)
    }
    return countActiveRequests(clientRequestsInFlight, now)
  }

  /**
   * 执行自救。
   * @returns {boolean} true 表示本实例的看门狗可以收工（已改写或本来就安全）；
   *   false 表示条件在判定后又变了（客户端报到 / 又有在途请求），下一 tick 再试。
   */
  const rescue = () => {
    /* 判定与写入之间可能隔着一次事件循环：boot.gif 刚到时绝不能把好端端的
       客户端禁用掉；新的资源请求刚开始时也要继续等。 */
    if (loadedByClient) return false
    if (activeInFlight(monotonicNow()) > 0) return false

    const backups = []
    const failures = []
    let changed = false
    for (const [patchPath, backupName] of [
      [bundlePatchPath, ORIGINAL_FILE],
      [profilePatchPath, PROFILE_ORIGINAL_FILE],
    ]) {
      let text
      try {
        text = fs.readFileSync(patchPath, 'utf8')
      } catch {
        continue // 这个补丁层不存在：跳过
      }
      const next = disableEntries(restoreEntries(text, RESCUE_RESTORES), RESCUE_DISABLES)
      if (next === text) continue
      try {
        const backup = path.join(stateDir, backupName)
        if (!fs.existsSync(backup)) writeFileAtomic(backup, text)
        writeFileAtomic(patchPath, next)
        backups.push(backup)
        changed = true
      } catch (error) {
        failures.push(patchPath)
        console.warn(`[terminal-workbench] 写回补丁层失败（${patchPath}），请手动检查：`, error)
      }
    }

    if (!changed) {
      console.log('[terminal-workbench] 补丁层已是安全状态（内置布局已启用、本插件已禁用），跳过')
      return true
    }

    const waited = Math.round((monotonicNow() - bootedAt) / 1000)
    const idle = Math.round((monotonicNow() - lastBrowserRequestAt) / 1000)
    console.warn(
      '[terminal-workbench] 浏览器已发起加载，但半侧未在时限内报到：' +
        '已还原内置布局（ui-layout / ui-sidebar-terminal）并禁用本插件（terminal-workbench）。' +
        `判定依据：启动 ${waited}s、最后加载活动 ${idle}s 前、在途请求 0。` +
        '重启 dsh 后即可恢复可用界面。' +
        `补丁备份：${backups.join('、')}；修复插件后，把备份覆盖回对应的 cordis.patch.yml 可恢复工作台布局。`,
    )
    if (failures.length > 0) {
      console.warn(`[terminal-workbench] 自救未完全生效，以下补丁层写入失败：${failures.join('、')}。请手动检查。`)
    }
    return true
  }

  const tick = () => {
    if (busy || finished) return
    busy = true
    void (async () => {
      try {
        if (loadedByClient) {
          finished = true
          stop()
          return
        }
        const now = monotonicNow()
        const inFlight = activeInFlight(now)
        /* 监听没挂上时无法区分“没人开页面”和“客户端失败”。宁可少救一次，
           也不要再出现 2026-11-07 那种“服务器重启没人开页面 → 误改补丁 → 白屏”。 */
        if (
          !shouldRescue({
            loadedByClient,
            browserRequestWatch,
            sawBrowserRequest,
            now,
            bootedAt,
            lastActivityAt: lastBrowserRequestAt,
            inFlight,
          })
        ) {
          return
        }
        let done = false
        try {
          done = rescue()
        } catch (error) {
          console.warn('[terminal-workbench] 自救执行失败，请手动检查补丁层：', error)
          done = true // 避免每 5 秒重复抛同一条错误
        }
        if (done) {
          finished = true
          stop()
        }
      } catch (error) {
        console.warn('[terminal-workbench] 自救检查失败：', error)
      } finally {
        busy = false
      }
    })()
  }

  timer = setInterval(tick, WATCHDOG_TICK_MS)
  watchdogTimer = timer
  timer.unref?.()
  tick()

  ctx.effect(
    () => () => {
      stop()
    },
    'terminal-workbench: boot rescue timer',
  )
}

/** 浏览器半侧是否已经报到（模块级：报到只会发生一次）。 */
let loadedByClient = false

/** 宽限期内是否见过“加载界面”的浏览器请求：区分“没人开页面”和“客户端真的没起来”。 */
let sawBrowserRequest = false

/** 最近一次客户端加载活动（请求开始或响应结束）的时间；看门狗从这一刻起算静默期。 */
let lastBrowserRequestAt = 0

/** 仍在下载/加载的客户端资源请求：请求 → 开始时间（单调毫秒）。
 *  用 Map 而不是计数，才能识别永远不结束的挂死请求。 */
let clientRequestsInFlight = new Map()

/** 浏览器请求监听是否挂上；挂不上时看门狗不动作（宁可不救，也不误改补丁）。 */
let browserRequestWatch = false

/** 当前看门狗的轮询定时器；报到成功或自救完成后清掉。 */
let watchdogTimer

/** 1x1 透明 GIF：报到信标的响应体（之前 404 是"故意的"，但 host 侧从没接住——那是 bug）。 */
const BOOT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** 停掉看门狗轮询（浏览器半侧报到后不再需要）。 */
function stopWatchdog() {
  if (watchdogTimer === undefined) return
  clearInterval(watchdogTimer)
  watchdogTimer = undefined
}

/** 浏览器半侧报到：置标志 + 停掉看门狗。 */
function markClientLoaded() {
  if (loadedByClient) return
  loadedByClient = true
  clientRequestsInFlight.clear()
  stopWatchdog()
  console.log('[terminal-workbench] 浏览器半侧已报到，启动看门狗解除')
}

/**
 * 读取并消费标记文件（读不到或不合格就返回 undefined）。
 * @returns {{ sessionId: string, text: string } | undefined} 合法的续话请求
 */
function consumeMarker() {
  let raw
  try {
    raw = fs.readFileSync(MARKER, 'utf8')
  } catch {
    return undefined // 没有标记：正常情况
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    try {
      fs.unlinkSync(MARKER)
    } catch {
      /* 删不掉也不影响主流程 */
    }
    return undefined
  }
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  const text = typeof payload?.text === 'string' ? payload.text : ''
  /* notBefore：排程重启时旧进程也会每 2s 轮询一次，若不看时间戳，
     "继续"会在重启前就被旧进程吃掉，重启后反而接不上。 */
  const notBefore = Number(payload?.notBefore)
  if (Number.isFinite(notBefore) && Date.now() < notBefore) return undefined
  if (sessionId === '' || text.trim() === '') {
    try {
      fs.unlinkSync(MARKER)
    } catch {
      /* 同上 */
    }
    return undefined
  }
  try {
    fs.unlinkSync(MARKER) // 先删再发：宁可漏发，也不要在失败时无限重试
  } catch {
    return undefined // 删不掉说明另一个进程在处理
  }
  return { sessionId, text }
}

/**
 * 把一条用户消息送进指定会话（带超时）。
 * @param {any} ctx 插件上下文
 * @param {{ sessionId: string, text: string }} request 续话请求
 */
async function deliver(ctx, request) {
  // `prompt` 是 @Remote 装饰过的方法，真实签名是 (request, signal)：
  // 装饰器内部会直接调 signal.throwIfAborted()，不传就抛 TypeError。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVER_TIMEOUT_MS)
  try {
    await ctx.sessionController.prompt(
      {
        requestId: `auto-continue-${crypto.randomUUID()}`,
        sessionId: request.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: request.text }],
      },
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 监听续话标记文件（目录级 watch + 文件名过滤）。
 *
 * 为什么监听目录而不是文件：标记文件平时**不存在**，fs.watch 对不存在的文件会
 * 直接抛 ENOENT；监听它所在的 `~/.dsh` 目录才能同时覆盖"新建"和"改写"。
 *
 * `persistent: false` 是关键：否则这个 watcher 会一直占着事件循环，dsh 主进程
 * 退出时被它挂住。
 *
 * @param {() => void} onChange 标记文件发生变化
 * @param {(reason: string) => void} onError 监听不可用或运行中出错
 * @returns {fs.FSWatcher | null} 监听句柄；监听不起来时返回 null，调用方退回轮询
 */
function watchMarker(onChange, onError) {
  const dir = path.dirname(MARKER)
  const base = path.basename(MARKER)
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      /* 目录级监听会收到同目录其它文件的事件，只认标记文件；
         部分平台 filename 为 null，此时不过滤——多跑一次空查询的代价远小于漏掉。 */
      if (typeof filename === 'string' && filename !== base) return
      onChange()
    })
    watcher.on('error', (error) => {
      onError(String(error?.message ?? error))
      try {
        watcher.close()
      } catch {
        /* 已经坏了，关不掉也无所谓 */
      }
    })
    return watcher
  } catch (error) {
    onError(String(error?.message ?? error))
    return null
  }
}

/**
 * 安装续话轮询。
 * @param {any} ctx 插件上下文（已声明 inject，可直接读 sessionController）
 */
export function apply(ctx) {
  console.log('[terminal-workbench] host 插件已加载，续话轮询启动')

  let busy = false
  const tick = async () => {
    if (busy) return
    const request = consumeMarker()
    if (request === undefined) return
    busy = true
    try {
      await deliver(ctx, request)
      console.log(`[terminal-workbench] 已向会话 ${request.sessionId} 送入：${request.text}`)
    } catch (error) {
      const detail = String(error?.stack ?? error)
      console.log(`[terminal-workbench] 续话失败（${request.sessionId}）：${detail}`)
      // 失败可溯源但不在内存里重试：写回文件，下一轮重启/轮询自然重来
      try {
        fs.writeFileSync(MARKER, JSON.stringify(request))
      } catch {
        /* 写回失败只能放弃，避免抛出未处理的异常 */
      }
    } finally {
      busy = false
    }
  }

  /* 终端工具：独立子插件，自带 inject（terminalController / tools）。
     终端写入权限完全跟随 DSH 权限预设，插件不再维护独立授权表。 */
  ctx.plugin(agentTerminal)

  /* 远端文件（v0.6.0）：把 ctx.fs 包成"本地 + SSH 远端"复合后端，
     再注册 remote_fs_list 让模型知道有哪些别名可用。 */
  const remotesFile = path.join(
    findProfileDir() ?? path.join(os.homedir(), '.dsh', 'profiles', 'default'),
    '.dsh-terminal-workbench',
    'remotes.json',
  )
  const remoteFs = wrapFileSystem(ctx, remotesFile)
  ctx.plugin(remoteFsTools, { remotesFile, probe: remoteFs.probe, remoteFs })
  ctx.effect(
    () => () => remoteFs.dispose(),
    'terminal-workbench: unwrap remote fs',
  )

  /* SSH 隧道（v0.8.0）：独立于 sftp 连接池——隧道要长期持有 client、
     监听端口、挂 tcp connection；连接池建完 sftp 就撒手，生命周期不同。
     与 remote-fs 共用同一份 remotes.json，跳板按 alias 的 jumpHost 解析。 */
  const forwardManager = new ForwardManager(remotesFile)
  ctx.plugin(forwardTools, { manager: forwardManager })
  ctx.effect(
    () => () => forwardManager.dispose(),
    'terminal-workbench: dispose forwards',
  )

  /* 启动自救：浏览器半侧没报到就还原 layout 补丁，避免白屏后无路可走。 */
  rescueOnBoot(ctx)

  /* 报到通道（v0.6.1 修复）：client.js 的 boot.gif 信标一直在发，但 host 侧
     从没注册过接收路由——loadedByClient 永远为 false，看门狗 45 秒必然误回滚。
     ctx.inject 等 webServer 就绪后才注册；没有 web 的 profile 只是不接信标，
     不影响插件其余部分。路由随 fiber 卸载自动摘除，重载不会产生重复注册。 */
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/__dsh-terminal-workbench/boot.gif',
          handler(req, res) {
            markClientLoaded()
            res.writeHead(200, {
              'content-type': 'image/gif',
              'cache-control': 'no-store',
              'content-length': BOOT_GIF.length,
            })
            res.end(BOOT_GIF)
          },
        }),
      'terminal-workbench: boot beacon route',
    )

    /* 执行进度信标（v0.9.4）：客户端脚本开始执行时先报一声，把“下载完了”
       和“正在执行”分开。慢机器上 10MB 包下载完到 root 槽注册之间可能超过
       静默期，只有 boot.gif 的话仍会被误判；进度信标会重置静默计时。 */
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/__dsh-terminal-workbench/boot-progress',
          handler(req, res) {
            if ((req?.method ?? 'GET') !== 'GET') {
              res.writeHead(405, { 'cache-control': 'no-store' })
              res.end()
              return
            }
            sawBrowserRequest = true
            lastBrowserRequestAt = monotonicNow()
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
          },
        }),
      'terminal-workbench: boot progress route',
    )

    /* 浏览器请求监听（v0.9.2）：看门狗不能把“没人打开页面”当成“客户端加载失败”，
       也不能把旧页面的 API 轮询当成“有人重新加载界面”。只有文档导航和客户端
       静态资源请求才算数；没有这类请求就安静等待，绝不动补丁。 */
    webCtx.effect(
      () => {
        const server = webCtx.webServer.server
        if (server === undefined) {
          console.warn('[terminal-workbench] 无法监听浏览器请求，自救看门狗将保持待命（不会自动改补丁）')
          return () => {}
        }
        const onRequest = (req, res) => {
          if (!isClientLoadRequest(req)) return
          const now = monotonicNow()
          sawBrowserRequest = true
          lastBrowserRequestAt = now
          /* 记录在途请求：10MB 级客户端包下载、解析期间可能几十秒没有新请求，
             只要它还没结束，就不能把“还在加载”当成“加载失败”。 */
          if (res === undefined || typeof res.once !== 'function') return
          clientRequestsInFlight.set(res, now)
          let settled = false
          const settle = () => {
            if (settled) return
            settled = true
            clientRequestsInFlight.delete(res)
            lastBrowserRequestAt = monotonicNow()
          }
          res.once('finish', settle)
          res.once('close', settle)
        }
        server.on('request', onRequest)
        browserRequestWatch = true
        return () => {
          server.off('request', onRequest)
          browserRequestWatch = false
          clientRequestsInFlight = new Map()
          lastBrowserRequestAt = 0
        }
      },
      'terminal-workbench: browser request watch',
    )

    /* 书签文件（v0.7.1）：主人可以直接编辑
       `<插件目录>/.dsh-terminal-workbench/bookmarks.json`，浏览器半侧启动时拉取并合并。
       文件不存在返回 404——客户端静默跳过，不弹错、不影响 localStorage 里已有的书签。
       格式：书签数组，或 { bookmarkGroups: [...], bookmarks: [...] }。 */
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/__dsh-terminal-workbench/bookmarks.json',
          handler(_req, res) {
            const profileDir = findProfileDir()
            const file =
              profileDir === undefined
                ? undefined
                : path.join(profileDir, '.dsh-terminal-workbench', 'bookmarks.json')
            let text
            try {
              text = file === undefined ? undefined : fs.readFileSync(file, 'utf8')
            } catch {
              text = undefined
            }
            if (text === undefined) {
              const body = JSON.stringify({ error: 'bookmarks-not-found' })
              res.writeHead(404, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
              })
              res.end(body)
              return
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(text),
            })
            res.end(text)
          },
        }),
      'terminal-workbench: bookmarks file route',
    )

    /* 文件面板 API（v0.8.0）：浏览器里没有 ctx.fs，面板的列目录/读写/
       移动/复制/删除都要回宿主执行。只在宿主侧拼路径，前端只发意图。 */
    registerFsApi(webCtx, { remoteFs, remotesFile })

    /* 相机取流代理（v0.10.0）：相机网页禁止 iframe 嵌入、Digest 认证也
       没法由 <img> 自带，统一由宿主认证后转成同源 MJPEG。 */
    registerCameraApi(webCtx)
  })

  void tick() // 启动时先查一次：重启排程的续话要立刻生效

  /* 续话调度：能监听就事件驱动（外加一道低频安全网），监听不起来就退回轮询。
     出错时把间隔切回 POLL_MS——宁可多耗一点 CPU，也不能收不到"继续"。 */
  let timer = null
  let intervalMs = POLL_MS
  const schedule = (ms) => {
    if (timer !== null) clearInterval(timer)
    intervalMs = ms
    timer = setInterval(() => {
      void tick()
    }, ms)
  }
  const fallback = (reason) => {
    if (intervalMs === POLL_MS) return // 已经在轮询了，不必反复切
    console.log(`[terminal-workbench] 续话监听退回轮询（${reason}）`)
    schedule(POLL_MS)
  }
  const watcher = watchMarker(() => {
    void tick()
  }, fallback)
  if (watcher === null) schedule(POLL_MS)
  else {
    console.log(`[terminal-workbench] 续话改用文件监听（安全网 ${Math.round(SAFETY_MS / 1000)}s）`)
    schedule(SAFETY_MS)
  }

  ctx.effect(
    () => () => {
      if (timer !== null) clearInterval(timer)
      if (watcher !== null) {
        try {
          watcher.close()
        } catch {
          /* 卸载时关闭失败无妨 */
        }
      }
    },
    'terminal-workbench: auto-continue poller',
  )
}
