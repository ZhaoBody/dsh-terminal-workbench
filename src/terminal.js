/**
 * dsh-terminal-plus 渲染层（懒加载 chunk 源码，构建后成为 client.terminal.js）。
 *
 * 职责单一：把 api-terminal-controller 的 TerminalView 数据流渲染成 xterm，
 * 并挂上 WebGL 渲染器 / Fit / Search / WebLinks。
 * 不碰 PTY 协议、不做 tab 编排（那是 client.js 的事）。
 *
 * @module dsh-terminal-plus/terminal
 */
import React from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { hasExportableContent, logLocation, saveTerminalLog } from './log-export.js'
import { loadLogDirectory, saveLogDirectory } from './log-directory-store.js'
import { runQuickSteps } from './quick-command-runner.js'

const h = React.createElement

/* 键名与默认值的单一来源是入口 client.js（见 window.__dshTerminalWorkbenchSettings）。
   这里只保留同值兜底：chunk 被单独加载（入口未执行）时仍然可用。 */
const SHARED_SETTINGS = (typeof window !== 'undefined' && window.__dshTerminalWorkbenchSettings) || {}
const SETTINGS_STORE_KEY = SHARED_SETTINGS.key ?? 'dsh-terminal-workbench.settings'
const SETTINGS_EVENT = SHARED_SETTINGS.event ?? 'dsh-terminal-workbench:settings-changed'

/** 读统一设置（缺失或损坏时返回空对象，调用方各自兜底）。 */
function readSettingsStore() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 快捷命令列表：{id, name, command}。 */
function normalizeQuickCommands(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string') continue
    /* 兼容早期单命令写法 {command} */
    const steps = Array.isArray(item.commands)
      ? item.commands
          .filter((step) => step !== null && typeof step === 'object')
          .map((step) => ({
            command: typeof step.command === 'string' ? step.command : '',
            delay: Number(step.delay) || 0,
          }))
      : typeof item.command === 'string' && item.command !== ''
        ? [{ command: item.command, delay: 0 }]
        : []
    if (steps.length === 0 || steps.every((step) => step.command === '')) continue
    /* electerm 导出用 labels 数组；单标签模式仍用 label，二者都保留。 */
    const labels = Array.isArray(item.labels)
      ? item.labels.filter((name) => typeof name === 'string' && name !== '')
      : []
    out.push({
      id: typeof item.id === 'string' ? item.id : 'qc-' + out.length,
      name: item.name,
      label: typeof item.label === 'string' && item.label !== '' ? item.label : labels[0] ?? '',
      labels,
      inputOnly: item.inputOnly === true,
      commands: steps,
    })
  }
  return out
}

/** 快捷栏高度：可拖拽，持久化到本地；双击手柄恢复默认。 */
const QUICKBAR_KEY = 'dsh-terminal-workbench.quickbarHeight'
const QUICKBAR_DEFAULT = 56
const QUICKBAR_MIN = 34
const QUICKBAR_MAX = 260

function readQuickbarHeight() {
  try {
    const stored = Number(window.localStorage.getItem(QUICKBAR_KEY))
    if (Number.isFinite(stored) && stored >= QUICKBAR_MIN) {
      return Math.min(QUICKBAR_MAX, Math.round(stored))
    }
  } catch (error) {
    /* 读不到就用默认高度 */
    console.warn('[terminal-workbench] 读不到就用默认高度：', error)
  }
  return QUICKBAR_DEFAULT
}

function writeQuickbarHeight(height) {
  try {
    window.localStorage.setItem(QUICKBAR_KEY, String(height))
  } catch (error) {
    /* 存不下就算了，仅影响下次打开 */
    console.warn('[terminal-workbench] 存不下就算了，仅影响下次打开：', error)
  }
}

function readQuickCommands() {
  return normalizeQuickCommands(readSettingsStore().quickCommands)
}

/** 模板变量：{{clipboard}} / {{time}} / {{date}}（执行时替换）。 */
async function fillQuickTemplates(text) {
  let out = String(text)
  if (out.includes('{{clipboard}}')) {
    /* 不能把剪贴板读取失败静默替换为空串并继续执行命令。 */
    const clip = await readClipboard()
    out = out.split('{{clipboard}}').join(clip)
  }
  const now = new Date()
  out = out.split('{{time}}').join(now.toLocaleTimeString())
  out = out.split('{{date}}').join(now.toLocaleDateString())
  return out
}

const QUICK_LABEL_KEY = 'dsh-terminal-workbench.quickLabel'
const QUICK_LABEL_EVENT = 'dsh-terminal-workbench:quick-label-changed'

function readQuickLabel() {
  try {
    const value = window.localStorage.getItem(QUICK_LABEL_KEY)
    return typeof value === 'string' ? value : ''
  } catch (error) {
    return ''
  }
}

function writeQuickLabel(value) {
  try {
    window.localStorage.setItem(QUICK_LABEL_KEY, value)
  } catch (error) {
    console.warn('[terminal-workbench] 保存快捷命令标签筛选失败：', error)
  }
  document.dispatchEvent(new CustomEvent(QUICK_LABEL_EVENT, { detail: { value } }))
}



function readCopyOnSelect() {
  try {
    const raw = window.localStorage.getItem(COPY_ON_SELECT_KEY)
    return raw === null ? true : raw === 'true'
  } catch (error) {
    return true
  }
}

/** 写剪贴板：拒绝时尝试传统复制，失败必须反馈给调用者。 */
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return }
    catch (error) {
      console.warn('[terminal-workbench] 剪贴板写入被拒绝，尝试传统复制：', error)
    }
  }
  fallbackCopy(text)
}

function fallbackCopy(text) {
  const area = document.createElement('textarea')
  try {
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝复制，请使用系统复制快捷键')
  } finally {
    area.remove()
  }
}

async function readClipboard() {
  if (!navigator.clipboard?.readText) throw new Error('浏览器不支持读取剪贴板，请使用系统粘贴快捷键')
  try { return await navigator.clipboard.readText() }
  catch (error) { throw new Error('剪贴板读取被拒绝，请授权或使用系统粘贴快捷键', { cause: error }) }
}

const FONT_KEY = SHARED_SETTINGS.legacyFontSizeKey ?? 'dsh-terminal-workbench.fontSize'
const FONT_MIN = 9
const FONT_MAX = 28
const FONT_DEFAULT = SHARED_SETTINGS.defaults?.fontSize ?? 13

function readFontSize() {
  try {
    const value = Number(window.localStorage.getItem(FONT_KEY))
    return Number.isFinite(value) && value >= FONT_MIN && value <= FONT_MAX ? value : FONT_DEFAULT
  } catch (error) {
    return FONT_DEFAULT
  }
}

function writeFontSize(size) {
  try {
    window.localStorage.setItem(FONT_KEY, String(size))
  } catch (error) {
    /* 隐私模式禁止 localStorage：字号只在当前标签生效 */
    console.warn('[terminal-workbench] 隐私模式禁止 localStorage：字号只在当前标签生效：', error)
  }
}

const MISSING_REOPEN_KEY = 'dsh-terminal-workbench.missing-reopen-at'

function readMissingReopenAt() {
  try {
    const value = Number(sessionStorage.getItem(MISSING_REOPEN_KEY))
    return Number.isFinite(value) ? value : 0
  } catch (error) {
    return 0
  }
}

function writeMissingReopenAt(value) {
  try {
    sessionStorage.setItem(MISSING_REOPEN_KEY, String(value))
  } catch (error) {
    /* 隐私模式禁止 sessionStorage 时，仍允许当前标签尝试一次。 */
    console.warn('[terminal-workbench] 隐私模式禁止 sessionStorage 时，仍允许当前标签尝试一次。：', error)
  }
}

function clearMissingReopenAt() {
  try {
    sessionStorage.removeItem(MISSING_REOPEN_KEY)
  } catch (error) {
    /* 存储不可用不影响终端渲染。 */
    console.warn('[terminal-workbench] 存储不可用不影响终端渲染。：', error)
  }
}

/**
 * 注入 xterm 官方样式（幂等）。
 * 缺失时 .xterm-helper-textarea 会以默认样式显示在左上角，
 * 且 .xterm-screen / 行容器布局失效，表现为整块面板空白。
 */
function ensureXtermStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-terminal-plus-xterm]') !== null) return
  const element = document.createElement('style')
  element.setAttribute('data-terminal-plus-xterm', '')
  element.textContent = xtermCss
  document.head.appendChild(element)
}

ensureXtermStyles()

/** 从 DSH 的 CSS 变量取当前主题配色。 */
/* electerm 默认主题（theme/default.txt）：背景 #121214、前景 #bbbbbb + 16 色 ANSI。 */
const ELECTERM_THEME = {
  foreground: '#bbbbbb',
  background: '#121214',
  cursor: '#b5bd68',
  cursorAccent: '#1d1f21',
  selectionBackground: 'rgba(200, 200, 200, 0.6)',
  black: '#575757',
  red: '#FF2C6D',
  green: '#19f9d8',
  yellow: '#FFB86C',
  blue: '#45A9F9',
  magenta: '#FF75B5',
  cyan: '#B084EB',
  white: '#CDCDCD',
  brightBlack: '#757575',
  brightRed: '#FF2C6D',
  brightGreen: '#19f9d8',
  brightYellow: '#FFCC95',
  brightBlue: '#6FC1FF',
  brightMagenta: '#FF9AC1',
  brightCyan: '#BCAAFE',
  brightWhite: '#E6E6E6',
}

/** 终端 chunk 与主 chunk 分开打包：配色表由 client.js 挂到 window 共享。 */
function __twbThemeOf(id) {
  const themes = window.__dshTerminalWorkbenchThemes
  if (themes === undefined || typeof themes.resolve !== 'function') return null
  try {
    return themes.resolve(id) || null
  } catch {
    return null
  }
}

/**
 * 终端配色：设置里选中的主题优先；`default` 或未知 id 回退 electerm 默认主题，
 * 保证 16 色 ANSI 与 electerm 一致。
 */
function readTheme() {
  const colors = __twbThemeOf(readSettingsStore().theme)
  return { ...(colors || ELECTERM_THEME) }
}

/**
 * 按容器尺寸算出 cols/rows，并同步到终端。
 * 几何永远跟随容器：不可写（只读）时只调本地 xterm，不反向改服务端 PTY 尺寸。
 * 尺寸越界（容器 0 宽）时直接放弃，避免 0x0 的 resize。
 */
function fitScreen(xterm, fit, state, model) {
  const dimensions = fit.proposeDimensions()
  if (dimensions === undefined) return
  const environment = state.environment
  const maxCols = environment === undefined ? Number.POSITIVE_INFINITY : environment.maxCols
  const maxRows = environment === undefined ? Number.POSITIVE_INFINITY : environment.maxRows
  const cols = Math.min(dimensions.cols, maxCols)
  const rows = Math.min(dimensions.rows, maxRows)
  if (cols < 2 || rows < 1) return
  if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
  /* PTY 已经同尺寸就不要再发 resize：重复 SIGWINCH 会让 TUI 反复重绘、画面撕裂。 */
  /* 本地排版与回写分开：标签不可写（分屏后非活动面板）时也要把画布量准，
     只是不要向 PTY 发 resize。 */
  const info = state.info
  if (info === undefined || info.cols !== cols || info.rows !== rows) {
    if (state.writable !== false) model.resize(cols, rows)
  }
}

/** 单个终端屏幕：xterm 实例生命周期 + 输出帧渲染 + 输入回写。 */
function TerminalScreen(props) {
  const { state, model, visible, label, theme, tabId } = props

  const { workspace } = props
  const element = React.useRef(null)
  const terminal = React.useRef()
  const fit = React.useRef()
  const search = React.useRef()
  const lastRevision = React.useRef(0)
  const firstFrame = React.useRef(true)
  const sentInput = React.useRef(false)
  const [quickCommands, setQuickCommands] = React.useState(readQuickCommands)
  const [notice, setNotice] = React.useState(null)
  const noticeTimer = React.useRef()
  const mounted = React.useRef(true)
  const exportInProgress = React.useRef(false)
  const logDirectory = React.useRef()
  const activeQuick = React.useRef()
  const [quickRun, setQuickRun] = React.useState(null)
  const showNotice = React.useCallback((message, error = false) => {
    if (!mounted.current) return
    window.clearTimeout(noticeTimer.current)
    setNotice({ message, error })
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }, [])
  React.useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(noticeTimer.current)
      activeQuick.current?.abort()
    }
  }, [model])
  React.useLayoutEffect(() => {
    if (!visible || state.writable !== true) activeQuick.current?.abort()
  }, [visible, state.writable])
  const [copyTip, setCopyTip] = React.useState(0)
  const copyTipTimer = React.useRef(0)
  const showCopyTip = React.useCallback(() => {
    setCopyTip((value) => value + 1)
    window.clearTimeout(copyTipTimer.current)
    copyTipTimer.current = window.setTimeout(() => setCopyTip(0), 1400)
  }, [])
  React.useEffect(() => () => window.clearTimeout(copyTipTimer.current), [])
  React.useEffect(() => {
    document.addEventListener('dsh-terminal-workbench:copy-tip', showCopyTip)
    return () => document.removeEventListener('dsh-terminal-workbench:copy-tip', showCopyTip)
  }, [showCopyTip])
  React.useEffect(() => {
    const onNotice = (event) => {
      if (event.detail?.tabId === tabId) showNotice(event.detail.message, event.detail.error === true)
    }
    document.addEventListener('dsh-terminal-workbench:notice', onNotice)
    return () => document.removeEventListener('dsh-terminal-workbench:notice', onNotice)
  }, [tabId, showNotice])
  const [quickLabel, setQuickLabel] = React.useState(readQuickLabel)
  React.useEffect(() => {
    const onQuickLabel = (event) => {
      const value = event.detail?.value
      if (typeof value === 'string') setQuickLabel(value)
    }
    const onStorage = (event) => {
      if (event.key === QUICK_LABEL_KEY) setQuickLabel(event.newValue ?? '')
    }
    document.addEventListener(QUICK_LABEL_EVENT, onQuickLabel)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener(QUICK_LABEL_EVENT, onQuickLabel)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  const [quickbarHeight, setQuickbarHeight] = React.useState(readQuickbarHeight)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const searchInput = React.useRef(null)

  const pendingInput = React.useRef()
  const current = React.useRef({ state, visible })
  current.current = { state, visible }

  React.useLayoutEffect(() => {
    const node = element.current
    if (node === null) return undefined
    const xterm = new Terminal({
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      fontSize: readFontSize(),
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      /* 挂载时 environment 可能还没下发：先给默认值，真实值在下面的 effect 里补齐。 */
      scrollback: current.current.state.environment?.scrollback ?? 5000,
      allowProposedApi: true,
    })
    firstFrame.current = true
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(node)
    /* 主 chunk 的部分增强功能（例如快捷指令后的焦点恢复）需要拿到实例；
       实例仍归本 chunk 所有，这里只暴露句柄，不转移生命周期。 */
    node.__dshXterm = xterm

    /* WebGL 优先，初始化失败静默回退 DOM 渲染（不阻断终端可用）。 */
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
      })
      xterm.loadAddon(webgl)
    } catch (error) {
      console.warn('[terminal-plus] WebGL 渲染器不可用，回退 DOM 渲染：', error)
    }

    try {
      const searchAddon = new SearchAddon()
      xterm.loadAddon(searchAddon)
      search.current = searchAddon
    } catch (error) {
      console.warn('[terminal-plus] Search addon 加载失败：', error)
    }

    try {
      xterm.loadAddon(
        new WebLinksAddon((event, uri) => {
          /* electerm 习惯：普通点击不跳转，Ctrl/Cmd+点击才打开，避免误触。 */
          if (!event.ctrlKey && !event.metaKey) return
          window.open(uri, '_blank', 'noopener')
        }),
      )
    } catch (error) {
      console.warn('[terminal-plus] WebLinks addon 加载失败：', error)
    }

    xterm.options.theme = readTheme()
    terminal.current = xterm
    fit.current = fitAddon
    lastRevision.current = 0

    const input = xterm.onData((data) => model.write(data))

    /* 选中即复制（可在设置里关掉）。 */
    const onSelectionChange = () => {
      if (!readCopyOnSelect()) return
      const text = xterm.getSelection()
      if (text === '') return
      Promise.resolve(writeClipboard(text)).then(showCopyTip, error => showNotice('复制失败：' + error.message, true))
    }
    const selectionSub = xterm.onSelectionChange(onSelectionChange)

    /* 右键：有选中即复制，无选中则粘贴（Windows Terminal / electerm 习惯）。 */
    const onContextPaste = (event) => {
      event.preventDefault()
      const selected = xterm.getSelection()
      if (selected !== '') {
        Promise.resolve(writeClipboard(selected)).then(showCopyTip, error => showNotice('复制失败：' + error.message, true))
        return
      }
      readClipboard().then((text) => {
        if (!mounted.current || !current.current.visible || current.current.state.writable !== true) {
          throw new Error('目标终端已隐藏、断开或不可写，未粘贴')
        }
        if (text !== '') model.write(text)
        else showNotice('剪贴板为空')
      }).catch(error => showNotice('粘贴失败：' + error.message, true))
    }
    node.addEventListener('contextmenu', onContextPaste)
    const measure = () => {
      if (node.clientWidth === 0 || node.clientHeight === 0) return
      fitScreen(xterm, fitAddon, current.current.state, model)
    }
    /* Ctrl+滚轮缩放字号（electerm 习惯），并持久化到本地。
       必须挂在捕获阶段：xterm 自己也在监听 wheel，当缓冲区还能滚动时它会
       preventDefault + stopPropagation，冒泡阶段我们就收不到了——这正是
       "只有滚到顶/底才能缩放"的原因。 */
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const currentSize = terminal.current?.options.fontSize ?? readFontSize()
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, currentSize + (event.deltaY < 0 ? 1 : -1)))
      if (terminal.current !== undefined && next !== currentSize) {
        terminal.current.options.fontSize = next
        writeFontSize(next)
        measure()
      }
    }
    node.addEventListener('wheel', onWheel, { capture: true, passive: false })

    /* Ctrl+F / Cmd+F 打开搜索栏；Esc 由搜索栏自己处理。 */
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        event.stopPropagation()
        setSearchOpen(true)
      }
    }
    node.addEventListener('keydown', onKeyDown, true)

    /* 设置页改字号/主题：立即应用并重新排版，无需刷新。 */
    const onSettings = (event) => {
      if (terminal.current === undefined) return
      const detail = event.detail ?? {}
      const size = Number(detail.fontSize)
      if (Number.isFinite(size)) {
        const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, size))
        if (terminal.current.options.fontSize !== clamped) {
          terminal.current.options.fontSize = clamped
          measure()
        }
      }
      terminal.current.options.theme = readTheme()
    }
    window.addEventListener(SETTINGS_EVENT, onSettings)

    /* 两个 chunk 的加载顺序没有保证：配色表后到时补一次主题。 */
    const __twbApplyTheme = () => {
      if (terminal.current !== undefined) terminal.current.options.theme = readTheme()
    }
    const __twbReadyEv = window.__dshTerminalWorkbenchThemes?.readyEvent ?? 'dsh-terminal-workbench:themes-ready'
    window.addEventListener(__twbReadyEv, __twbApplyTheme)

    const observer = new ResizeObserver(() => {
      measure()
      /* 面板做入场动画时首帧尺寸可能是过渡值，稍后再量一次。 */
      window.setTimeout(measure, 90)
    })
    observer.observe(node)
    if (node.parentElement !== null) observer.observe(node.parentElement)
    /* 分屏/窗口缩放时容器尺寸变化可能不产生 RO 回调（面板在动画层里），
       用窗口 resize 兜底再量一次。 */
    const onWindowResize = () => measure()
    window.addEventListener('resize', onWindowResize)
    /* 挂载瞬间容器尺寸可能还没稳定，补一次测量。 */
    const initial = window.requestAnimationFrame(measure)

    return () => {
      window.cancelAnimationFrame(initial)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      node.removeEventListener('wheel', onWheel, true)
      node.removeEventListener('keydown', onKeyDown, true)
      node.removeEventListener('contextmenu', onContextPaste)
      window.removeEventListener(SETTINGS_EVENT, onSettings)
      window.removeEventListener(__twbReadyEv, __twbApplyTheme)
      selectionSub.dispose()
      input.dispose()
      if (pendingInput.current !== undefined) {
        window.clearTimeout(pendingInput.current)
        pendingInput.current = undefined
      }
      xterm.dispose()
      terminal.current = undefined
      fit.current = undefined
      search.current = undefined
    }
  }, [model])

  /* scrollback 运行时补齐：首帧前 environment 可能为空，之后按宿主值覆盖。 */
  React.useLayoutEffect(() => {
    const scrollback = state.environment?.scrollback
    if (terminal.current !== undefined && scrollback !== undefined) {
      terminal.current.options.scrollback = scrollback
    }
  }, [state.environment?.scrollback])

  /* 主题切换后重取颜色。 */
  React.useLayoutEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.theme = readTheme()
  }, [theme])

  /* 一帧终端输出：snapshot 先 reset+resize，再 write 并回 ack。 */
  React.useLayoutEffect(() => {
    const xterm = terminal.current
    const render = state.render
    if (xterm === undefined || render === undefined) return
    if (render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    const frameType = render.frame.type
    if (firstFrame.current) {
      firstFrame.current = false
      if (frameType !== 'snapshot') {
        model.connect()
        return
      }
    }
    if (frameType === 'snapshot') {
      xterm.reset()
      /* 关键：本地尺寸与 PTY 尺寸必须一致。
         可写时以容器为准并同步给 PTY（fitScreen 会发 resize），
         只读时不能改 PTY，就反过来按 PTY 尺寸渲染。
         两边只要不一致，TUI 输出就会按旧宽度折行 —— 表现为乱码 + 光标错位。 */
      const host = element.current
      const info = render.frame.info
      if (state.writable && host !== null && host.clientWidth > 0 && host.clientHeight > 0) {
        fitScreen(xterm, fit.current, state, model)
      } else if (info !== undefined && info.cols >= 2 && info.rows >= 1) {
        if (xterm.cols !== info.cols || xterm.rows !== info.rows) xterm.resize(info.cols, info.rows)
      }
    }
    xterm.write(frameType === 'snapshot' ? render.frame.screen : render.frame.data, () => {
      model.acknowledge(render.revision)
      /* 新建标签携带的初始命令（如 ssh user@host）：首屏落定后只写一次。
         略等一拍，让 shell 先打印提示符，命令不会落在提示符之前。 */
      if (
        frameType === 'snapshot' &&
        !sentInput.current &&
        typeof props.initialInput === 'string' &&
        props.initialInput !== ''
      ) {
        sentInput.current = true
        const timer = window.setTimeout(() => {
          try {
            const raw = props.initialInput
            if (raw.indexOf('\r') === -1) {
              model.write(raw + '\r')
            } else {
              /* 多行初始命令：逐行写入并留出 shell 处理时间，
                 避免密码/确认提示还没出来就被下一行冲掉。 */
              const parts = raw.split('\r')
              for (let index = 0; index < parts.length; index += 1) {
                window.setTimeout(() => {
                  try {
                    model.write(parts[index] + '\r')
                  } catch {
                    /* 终端可能已关闭：忽略 */
                  }
                }, index * 140)
              }
            }
            /* initialInput 只应随一个新标签执行一次。写入后通知外层消费它；
               会话切换导致本组件重新挂载时，外层不会再把它传回来。 */
            if (typeof props.markInitialInputSent === 'function') {
              props.markInitialInputSent(tabId, props.initialInput)
            }
          } catch (error) {
            /* 终端可能在等待期间被关闭：忽略，不阻断渲染 */
            console.warn('[terminal-workbench] 终端可能在等待期间被关闭：忽略，不阻断渲染：', error)
          }
        }, 350)
        pendingInput.current = timer
      }
    })
  }, [state.render, model])

  /* 可写状态与尺寸：几何始终跟随容器，writable 只控制是否接受输入。 */
  React.useLayoutEffect(() => {
    const xterm = terminal.current
    if (xterm === undefined) return
    xterm.options.disableStdin = !state.writable
    const node = element.current
    if (state.writable && node !== null && node.clientWidth > 0 && node.clientHeight > 0) {
      fitScreen(xterm, fit.current, state, model)
    } else if (state.info !== undefined && state.info.cols >= 2 && state.info.rows >= 1) {
      /* 只读时不能改 PTY 尺寸，就按 PTY 的真实尺寸渲染，杜绝宽度错位。 */
      if (xterm.cols !== state.info.cols || xterm.rows !== state.info.rows) {
        xterm.resize(state.info.cols, state.info.rows)
      }
    }
  }, [visible, state.writable, state.info?.cols, state.info?.rows, model])

  /* 设置页改了快捷命令，这里跟着刷新。 */
  React.useEffect(() => {
    const onSettings = () => setQuickCommands(readQuickCommands())
    window.addEventListener(SETTINGS_EVENT, onSettings)
    return () => window.removeEventListener(SETTINGS_EVENT, onSettings)
  }, [])

  /* 搜索栏打开后聚焦输入框（下一拍，等元素挂上）。 */
  React.useEffect(() => {
    if (searchOpen && searchInput.current !== null) {
      searchInput.current.focus()
      searchInput.current.select()
    }
  }, [searchOpen])

  /* 搜索命中导航：向 SearchAddon 要下一处/上一处。 */
  const runSearch = (backwards) => {
    const addon = search.current
    if (addon === undefined || query === '') return
    if (backwards) addon.findPrevious(query)
    else addon.findNext(query)
  }

    /* 日志动作只监听当前标签；不支持/失败/取消均不标记为成功。 */
  React.useEffect(() => {
    const onExport = async (event) => {
      if (event.detail?.tabId !== tabId) return
      if (exportInProgress.current) { showNotice('日志正在保存，请稍候'); return }
      const node = element.current
      for (const key of ['data-tp-log-exported', 'data-tp-log-lines', 'data-tp-log-tab', 'data-tp-log-path']) node?.removeAttribute(key)
      const xterm = terminal.current
      if (xterm === undefined) { showNotice('终端尚未就绪', true); return }
      const buffer = xterm.buffer.active
      const lines = []
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      }
      const text = lines.join('\n').replace(/\s+$/, '')
      if (!hasExportableContent(text)) { showNotice('终端里没有可导出的内容'); return }
      exportInProgress.current = true
      try {
        /* 在任何目录授权前校验上下文；名称和时间取点击这一刻的快照。 */
        const options = { workspace, terminalName: label, text, now: new Date() }
        logLocation(options)
        let root = logDirectory.current
        let rememberWarning = false
        if (root === undefined) {
          try { root = await loadLogDirectory() }
          catch (error) {
            console.warn('[terminal-workbench] 读取日志目录记录失败：', error)
            rememberWarning = true
          }
        }
        if (root) {
          let permission = await root.queryPermission({ mode: 'readwrite' })
          if (permission !== 'granted') permission = await root.requestPermission({ mode: 'readwrite' })
          if (permission !== 'granted') throw new Error('未获得日志目录写入权限，本次未保存')
        } else {
          if (typeof window.showDirectoryPicker !== 'function') {
            throw new Error('当前浏览器不支持保存到专用目录，请使用支持目录选择的浏览器；未下载任何文件')
          }
          root = await window.showDirectoryPicker({ id: 'dsh-terminal-logs', mode: 'readwrite', startIn: 'documents' })
          try { await saveLogDirectory(root) }
          catch (error) {
            console.warn('[terminal-workbench] 记住日志目录失败：', error)
            rememberWarning = true
          }
        }
        logDirectory.current = root
        const result = await saveTerminalLog(root, options)
        if (node?.isConnected) {
          node.setAttribute('data-tp-log-exported', String(text.length))
          node.setAttribute('data-tp-log-lines', String(buffer.length))
          node.setAttribute('data-tp-log-tab', String(tabId))
          node.setAttribute('data-tp-log-path', result.path)
        }
        showNotice('已保存：' + result.path + (rememberWarning ? '（目录记录未能持久化，下次可能需要重选）' : ''))
      } catch (error) {
        if (error?.name === 'AbortError') showNotice('已取消日志保存')
        else {
          /* null 表示上次目录失败；下次点击跳过旧句柄，允许重新选择。 */
          logDirectory.current = null
          console.warn('[terminal-workbench] 日志保存失败：', error)
          showNotice('日志保存失败：' + (error?.message ?? String(error)) + '。再次导出可重新选择目录', true)
        }
      } finally {
        exportInProgress.current = false
      }
    }
    document.addEventListener('dsh-terminal-workbench:export-log', onExport)
    return () => document.removeEventListener('dsh-terminal-workbench:export-log', onExport)
  }, [tabId, label, workspace, showNotice])

  React.useEffect(() => {
    if (terminal.current?.textarea) terminal.current.textarea.setAttribute('aria-label', label)
  }, [label])

  /* Label 去重用作出栏筛选下拉；选中的标签被删掉时回落到「全部」。 */
  /* electerm 式多标签：labels 优先，单标签写法用 label 兜底。 */
  const labelsOf = (item) =>
    Array.isArray(item.labels) && item.labels.length > 0
      ? item.labels
      : typeof item.label === 'string' && item.label !== ''
        ? [item.label]
        : []
  const quickLabels = []
  for (const item of quickCommands) {
    for (const name of labelsOf(item)) {
      if (!quickLabels.includes(name)) quickLabels.push(name)
    }
  }
  const quickLabelValue = quickLabels.includes(quickLabel) ? quickLabel : ''
  const quickMatches =
    quickLabelValue === '' ? quickCommands : quickCommands.filter((item) => labelsOf(item).includes(quickLabelValue))

  /* 拖动手柄调整快捷栏高度（向上拉变高），双击恢复默认。 */
  const onQuickbarResizeStart = (event) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = quickbarHeight
    const onMove = (moveEvent) => {
      const next = Math.min(
        QUICKBAR_MAX,
        Math.max(QUICKBAR_MIN, Math.round(startHeight - (moveEvent.clientY - startY))),
      )
      setQuickbarHeight(next)
      writeQuickbarHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const resetQuickbarHeight = () => {
    setQuickbarHeight(QUICKBAR_DEFAULT)
    writeQuickbarHeight(QUICKBAR_DEFAULT)
  }

  /* 一个终端同时只运行一个快捷序列；切换/隐藏/卸载只取消未投递步骤。 */
  const runQuick = async (item) => {
    if (activeQuick.current) return
    const controller = new AbortController()
    activeQuick.current = controller
    setQuickRun({ name: item.name, step: 0, total: item.commands.length })
    try {
      const result = await runQuickSteps({
        item,
        signal: controller.signal,
        resolveText: fillQuickTemplates,
        write: (input) => model.write(input),
        isWritable: () => mounted.current && current.current.visible && current.current.state.writable === true,
        onStep: (step) => {
          if (!mounted.current) return
          element.current?.setAttribute('data-tp-last-command', step.text)
          setQuickRun({ name: item.name, step: step.step, total: step.total })
        },
      })
      if (result.status === 'failed') showNotice('快捷命令第 ' + result.step + '/' + result.total + ' 步失败：' + result.message, true)
      else if (result.status === 'cancelled') showNotice('已停止后续快捷命令步骤；已发送的命令不受影响')
      else showNotice('快捷命令输入已投递（' + result.total + ' 步），请在终端查看执行结果')
    } finally {
      if (activeQuick.current === controller) {
        activeQuick.current = undefined
        if (mounted.current) setQuickRun(null)
      }
    }
  }

  return h(
    React.Fragment,
    null,
    h('div', { className: 'tp-screen', ref: element }),
    notice === null ? null : h('div', {
      className: 'tp-copy-tip', role: notice.error ? 'alert' : 'status',
      'aria-live': notice.error ? 'assertive' : 'polite', 'data-tp-notice': notice.error ? 'error' : 'info',
      style: { maxWidth: 'calc(100% - 32px)', whiteSpace: 'normal', overflowWrap: 'anywhere' },
    }, notice.message),
    quickRun === null ? null : h('div', { className: 'tp-quickbar tp-quick-progress', role: 'status', 'aria-live': 'polite' },
      '正在投递：' + quickRun.name + ' ' + quickRun.step + '/' + quickRun.total + ' ',
      h('button', { type: 'button', className: 'tp-quick-chip', title: '只停止后续输入，不中断已经执行的命令',
        onClick: () => activeQuick.current?.abort() }, '停止后续步骤')),
    copyTip > 0 && notice === null
      ? h('div', { className: 'tp-copy-tip', role: 'status', 'aria-live': 'polite' }, '已复制')
      : null,
    quickCommands.length === 0
      ? null
      : h(
          React.Fragment,
          null,
          h('div', {
            className: 'tp-quickbar-handle',
            role: 'separator',
            'aria-orientation': 'horizontal',
            'aria-label': '拖动调整快捷栏高度',
            'data-quickbar-handle': '1',
            title: '拖动调整高度，双击恢复默认',
            onMouseDown: onQuickbarResizeStart,
            onDoubleClick: resetQuickbarHeight,
          }),
          h(
          'div',
          {
            className: 'tp-quickbar',
            role: 'toolbar',
            'aria-label': '快捷指令',
            style: { height: quickbarHeight + 'px' },
            'data-quickbar-height': String(quickbarHeight),
          },
          h('span', { className: 'tp-quickbar-label' }, '快捷'),
          quickLabels.length === 0
            ? null
            : h(
                'select',
                {
                  className: 'tp-quick-label',
                  'data-quick-label': '1',
                  'aria-label': '按标签筛选快捷命令',
                  value: quickLabelValue,
                  onChange: (event) => { const value = event.target.value; setQuickLabel(value); writeQuickLabel(value) },
                },
                h('option', { value: '', key: '' }, '全部标签'),
                ...quickLabels.map((name) => h('option', { value: name, key: name }, name)),
              ),
          ...quickMatches.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'tp-quick-chip',
                disabled: quickRun !== null || !visible || state.writable !== true,
                title: item.commands.map((step) => step.command).join(' ↵ '),
                onClick: () => {
                  /* 点快捷指令会把焦点留在按钮上：执行前把焦点还给终端，
                     执行后再还一次，用户不必手动点终端才能继续输入。 */
                  const focusTerminal = () => {
                    const textarea = element.current?.querySelector('.xterm-helper-textarea')
                    if (textarea) textarea.focus()
                  }
                  focusTerminal()
                  runQuick(item).finally(focusTerminal)
                },
              },
              item.name,
            ),
          ),
        ),
        ),
    searchOpen
      ? h(
          'div',
          { className: 'tp-search', role: 'search' },
          h('input', {
            className: 'tp-search-input',
            ref: searchInput,
            value: query,
            placeholder: '搜索终端内容…',
            'aria-label': '搜索终端内容',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setSearchOpen(false)
              }
            },
          }),
          h('button', { type: 'button', className: 'tp-search-btn', onClick: () => runSearch(true), 'aria-label': '上一处' }, '↑'),
          h('button', { type: 'button', className: 'tp-search-btn', onClick: () => runSearch(false), 'aria-label': '下一处' }, '↓'),
          h('button', { type: 'button', className: 'tp-search-btn', onClick: () => setSearchOpen(false), 'aria-label': '关闭搜索' }, '×'),
        )
      : null,
  )
}

/**
 * 终端标签主体：挂载 TerminalView（PTY 生命周期），按状态渲染屏幕或空态。
 * @param props - sidebar.right.pane.tab 注入的 view/keyedHooks 与 tab 信息。
 */
export function TerminalBody(props) {
  const { useTabInfo, useTerminal, useTheme, view, t } = props
  const { tab } = useTabInfo()
  const model = view(tab.id)
  const state = useTerminal(tab.id)
  const theme = useTheme((value) => value)
  /* 在槽位主体读取工作区，再显式传给屏幕，避免中间组件漏传 selector hook。 */
  const workspace = typeof props.useWorkspaces === 'function'
    ? props.useWorkspaces((snapshot) => snapshot.items.find(item => item.sessionIds.includes(props.sessionId)))
    : undefined

  React.useEffect(() => {
    const detach = model.mount()
    return detach
  }, [model])

  /* 服务重启后旧 PTY 会消失，此时客户端快照可能永远等不到（state 一直是
     undefined）——只靠 missingTerminal 判不出来，会留一张永久空白标签。
     这里给一个宽限：若干秒内拿不到快照就按"已失效"处理。 */
  const [stale, setStale] = React.useState(false)
  React.useEffect(() => {
    if (state !== undefined) {
      setStale(false)
      return undefined
    }
    const timer = window.setTimeout(() => setStale(true), 6000)
    return () => window.clearTimeout(timer)
  }, [state])

  /* failed 可能是开机过程中的瞬时态（例如刚开就撞上 terminalLimit），
     必须稳定持续一段时间才算真死，否则会把好端端的终端关掉。 */
  const [deadConfirmed, setDeadConfirmed] = React.useState(false)
  React.useEffect(() => {
    const dead =
      state?.issue === 'missingTerminal' ||
      state?.phase === 'failed' ||
      (state === undefined && stale)
    if (!dead) {
      setDeadConfirmed(false)
      return undefined
    }
    const timer = window.setTimeout(() => setDeadConfirmed(true), 3000)
    return () => window.clearTimeout(timer)
  }, [state, stale])

  /* 绑定丢失（会话恢复后终端已不存在）：短时间内只自动重开一次。 */
  const reopened = React.useRef(false)
  const [recoveryFailed, setRecoveryFailed] = React.useState(false)
  React.useEffect(() => {
    const dead = deadConfirmed
    if (!dead) {
      clearMissingReopenAt()
      return
    }
    if (reopened.current) return
    reopened.current = true
    const now = Date.now()
    const lastAttempt = readMissingReopenAt()
    if (now - lastAttempt < 5000) {
      setRecoveryFailed(true)
      return
    }
    writeMissingReopenAt(now)
    try {
      /* 旧 PTY 已死但占着终端名额（issue: terminalLimit），先关它再开新的。 */
      if (typeof props.closeTab === 'function') props.closeTab(tab.id)
      window.setTimeout(() => {
        try {
          if (typeof props.openTab === 'function') props.openTab()
          else tab.actions.openTab('terminal', { replaceTab: true })
        } catch (error) {
          setRecoveryFailed(true)
        }
      }, 150)
    } catch (error) {
      setRecoveryFailed(true)
    }
  }, [deadConfirmed, tab, props])

  if (state === undefined && !stale) return null

  if (state === undefined || state.issue === 'missingTerminal' || state.phase === 'failed') {
    if (!recoveryFailed) return null
    return h(
      'div',
      { className: 'tp-recovery-failed', role: 'status' },
      '本地终端恢复失败，请关闭此标签后从加号重新打开。',
    )
  }

  return h(
    'div',
    { className: 'tp-root' },
    h(TerminalScreen, {
      state,
      model,
      visible: tab.visible,
      tabId: tab.id,
      workspace,
      label: props.terminalTitle ?? state.info?.title ?? tab.title ?? 'terminal',
      theme,
      initialInput: typeof props.initialInput === 'string' ? props.initialInput : undefined,
      /* 透传投递确认：缺失时屏幕虽写入命令，外层却永远无法记录已消费状态。 */
      markInitialInputSent: props.markInitialInputSent,
    }),
  )
}
