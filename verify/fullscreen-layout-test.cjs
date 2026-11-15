#!/usr/bin/env node
/**
 * 右栏「全屏」布局回归。
 *
 * 背景：宿主 `dsh-client-ui-sidebar-right` 的 PanelChrome 点「全屏」后，
 * 经 `layout.openRightbar(track, fullscreen)` 只把 `rightbarFullscreen`
 * 写进我们的 store；旧代码存了却从不读，按钮点了等于没反应。
 *
 * 这里锁两件事：
 *   1. 纯函数 computeFrame 在 fullscreen 时真的把网格切成左右 0、中列吃满；
 *   2. client.js 的接线（data 属性、宿主面板宽度、拖拽把手/相机浮层）没有退化。
 *
 * 运行：node verify/fullscreen-layout-test.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')

const CLIENT = path.join(__dirname, '..', 'client.js')
const code = fs.readFileSync(CLIENT, 'utf8')

let definition
const localStorage = {
  getItem() { return null },
  setItem() {},
  removeItem() {},
}
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
        style: {},
        dataset: {},
        setAttribute() {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        querySelector() { return null },
      }
    },
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  Node: class Node {},
  CustomEvent: class CustomEvent {
    constructor(type, options) {
      this.type = type
      this.detail = options && options.detail
    }
  },
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
      lazy(value) { return value },
      Suspense: function Suspense() {},
      useState() {},
      useEffect() {},
      useRef() {},
      useCallback() {},
      useMemo() {},
      useSyncExternalStore() {},
      createElement() {},
    }
  }
  if (name === 'react-dom') return { createPortal() {} }
  if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
  if (name === '@deepseek-ai/dsh-client-store') return { defineStore() {} }
  return {}
}
const exported = definition.factory(requireStub)
const layout = exported.__twbLayout
assert.ok(layout, 'client.js 应导出 __twbLayout 测试缝')
assert.strictEqual(typeof layout.computeFrame, 'function', 'computeFrame 必须是函数')
assert.strictEqual(typeof layout.computeColumns, 'function', 'computeColumns 必须是函数')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${error && error.message}`)
  }
}

const VIEWPORT = 1600
const COLLAPSED = 56

function frameOf(extra) {
  const layoutInfo = Object.assign(
    { rightbarShown: true, rightbarFullscreen: false },
    extra
  )
  /* 与 AppFrame 一致：右栏未展示时偏好宽度按 0 传。 */
  const rightbar = layoutInfo.rightbarShown ? 560 : 0
  return layout.computeFrame(layoutInfo, VIEWPORT, 280, rightbar, COLLAPSED)
}

/* ------------------------------------------------------------------ */
/* 纯函数：全屏必须改网格                                              */
/* ------------------------------------------------------------------ */

test('非全屏时保持三栏，网格列与 computeColumns 一致', () => {
  const frame = frameOf()
  const cols = layout.computeColumns(VIEWPORT, 280, 560, COLLAPSED)
  assert.strictEqual(frame.fullscreen, false)
  assert.strictEqual(frame.sidebar, cols.sidebar)
  assert.strictEqual(frame.center, cols.center)
  assert.strictEqual(frame.rightbar, cols.rightbar)
  assert.strictEqual(
    frame.gridTemplate,
    `${cols.sidebar}px minmax(0px, ${cols.rightbar}px) minmax(400px, 1fr)`
  )
})

test('全屏时左右列收成 0，中列吃满视口', () => {
  const frame = frameOf({ rightbarFullscreen: true })
  assert.strictEqual(frame.fullscreen, true, 'fullscreen 应为 true')
  assert.strictEqual(frame.sidebar, 0, '左栏必须归零')
  assert.strictEqual(frame.center, VIEWPORT, '中列必须等于视口宽')
  assert.strictEqual(frame.rightbar, VIEWPORT, '右栏必须等于视口宽')
  assert.strictEqual(frame.gridTemplate, '0px minmax(0px, 1fr) 0px')
})

test('全屏网格模板不再含固定像素右栏', () => {
  const frame = frameOf({ rightbarFullscreen: true })
  assert.ok(!/\d+px minmax\(0px, \d+px\)/.test(frame.gridTemplate), '不应残留三栏模板')
})

test('右栏未展示时忽略 fullscreen，避免整帧被清空', () => {
  const frame = frameOf({ rightbarFullscreen: true, rightbarShown: false })
  assert.strictEqual(frame.fullscreen, false)
  assert.ok(frame.center > 0, '中列不能被清空')
  assert.strictEqual(frame.rightbar, 0, '右栏未展示应为 0')
})

test('fullscreen 只认严格 true，脏值不触发', () => {
  for (const dirty of ['true', 1, {}, null, undefined]) {
    const frame = frameOf({ rightbarFullscreen: dirty })
    assert.strictEqual(frame.fullscreen, false, `脏值 ${String(dirty)} 不应全屏`)
  }
})

test('全屏不依赖 sidebar/rightbar 偏好值', () => {
  const a = layout.computeFrame(
    { rightbarShown: true, rightbarFullscreen: true },
    VIEWPORT,
    0,
    0,
    0
  )
  const b = layout.computeFrame(
    { rightbarShown: true, rightbarFullscreen: true },
    VIEWPORT,
    900,
    1200,
    56
  )
  assert.deepStrictEqual(a, b)
  assert.strictEqual(a.gridTemplate, '0px minmax(0px, 1fr) 0px')
})

test('窄视口非全屏时右栏让位，中列不为负', () => {
  const frame = layout.computeFrame(
    { rightbarShown: true, rightbarFullscreen: false },
    700,
    280,
    560,
    COLLAPSED
  )
  assert.strictEqual(frame.rightbar, 0)
  assert.strictEqual(frame.center, 700 - frame.sidebar)
  assert.ok(frame.center >= 0)
})

test('退出全屏能回到原三栏', () => {
  const before = frameOf()
  frameOf({ rightbarFullscreen: true })
  const after = frameOf()
  assert.deepStrictEqual(after, before)
})

/* ------------------------------------------------------------------ */
/* 接线：状态必须落到 DOM 与宿主面板                                   */
/* ------------------------------------------------------------------ */

test('AppFrame 使用 computeFrame 的 gridTemplate', () => {
  assert.ok(/var frame = computeFrame\(/.test(code), 'AppFrame 应调用 computeFrame')
  assert.ok(/var gridTemplate = frame\.gridTemplate/.test(code), '网格模板应取自 frame')
})

test('全屏时帧带 data-rightbar-fullscreen 标记', () => {
  assert.ok(
    /"data-rightbar-fullscreen": rightbarFullscreen \? "1" : undefined/.test(code),
    'data-rightbar-fullscreen 必须是 "1"，与 CSS 选择器一致'
  )
})

test('全屏 CSS 隐藏左右列', () => {
  assert.ok(
    /\.wb-frame\[data-rightbar-fullscreen='1'\] \.wb-sidebar-col/.test(code),
    '缺少左栏隐藏规则'
  )
  assert.ok(
    /\.wb-frame\[data-rightbar-fullscreen='1'\] \.wb-main-col/.test(code),
    '缺少中栏隐藏规则'
  )
})

test('终端列把全屏标记传给宿主面板', () => {
  assert.ok(/function TerminalColumn\(props\)/.test(code))
  assert.ok(
    /"data-fullscreen": props\.fullscreen \? "1" : undefined/.test(code),
    'TerminalColumn 应输出 data-fullscreen'
  )
  assert.ok(/fullscreen: rightbarFullscreen,/.test(code), 'AppFrame 应把全屏标记传给终端列')
})

test('宿主全屏面板宽度贴合 100%，不留 100vw 横向溢出', () => {
  assert.ok(
    /\[data-sidebar-right-panel='fullscreen'\]\{width:100%!important/.test(code),
    '缺少宿主面板宽度覆盖'
  )
})

test('全屏时隐藏相机浮层与拖拽把手', () => {
  assert.ok(/visible: !rightbarFullscreen && cols\.rightbar > 0/.test(code), '相机浮层未受控')
  assert.ok(/!rightbarFullscreen &&\s*!sidebarCollapsed &&/.test(code), '左把手未受控')
  assert.ok(/!rightbarFullscreen &&\s*cols\.rightbar > 0 &&/.test(code), '右把手未受控')
})

test('宿主 openRightbar 仍把 fullscreen 写入 store', () => {
  assert.ok(
    /d\.layoutInfo\.rightbarFullscreen = fullscreen/.test(code),
    'openRightbar 必须持久化 fullscreen'
  )
})

/* ------------------------------------------------------------------ */

console.log(`\n== 全屏布局：${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
