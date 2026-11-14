#!/usr/bin/env node
/**
 * 书签文件（bookmarks.json）合并回归。
 *
 * 只取 client.js 暴露的 `__dshTerminalWorkbenchBookmarks` 测试缝，
 * 不加载 React / xterm / DOM 渲染。
 *
 * 运行：node verify/bookmarks-file-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const store = new Map()
const writes = []
const localStorage = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null
  },
  setItem(key, value) {
    store.set(key, String(value))
    writes.push(key)
  },
  removeItem(key) {
    store.delete(key)
  },
}

let definition
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) {
      return setTimeout(fn, 0)
    },
    cancelAnimationFrame(id) {
      clearTimeout(id)
    },
  },
  document: {
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return { style: {}, dataset: {}, setAttribute() {}, appendChild() {} }
    },
    querySelector() {
      return null
    },
    body: null,
  },
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init && init.detail
    }
  },
  AbortController,
  TextEncoder,
  btoa(value) {
    return Buffer.from(String(value), 'binary').toString('base64')
  },
  setTimeout,
  clearTimeout,
  queueMicrotask,
  URL,
  URLSearchParams,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const requireStub = (name) => {
  if (name === 'react') {
    return {
      lazy(value) {
        return value
      },
      Suspense() {},
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
definition.factory(requireStub)

const seam = sandbox.window.__dshTerminalWorkbenchBookmarks
assert.ok(seam, 'client.js 应暴露 __dshTerminalWorkbenchBookmarks 测试缝')

const SETTINGS_KEY = 'dsh-terminal-workbench.settings'
const SEEN_KEY = 'dsh-terminal-workbench.file-bookmarks-seen'

function reset() {
  store.clear()
  writes.length = 0
}
function setSettings(settings) {
  store.set(SETTINGS_KEY, JSON.stringify(settings))
}
function getSettings() {
  return JSON.parse(store.get(SETTINGS_KEY))
}
function settingsWrites() {
  return writes.filter((key) => key === SETTINGS_KEY).length
}
function mockFetch(body, ok = true) {
  sandbox.fetch = async () => ({
    ok,
    async text() {
      return body
    },
  })
}

let passed = 0
let failed = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

/* ------------------------------------------------------------------ */
/* 1. 文件条目归一化：分组可以写名字，id 可以省略                      */
/* ------------------------------------------------------------------ */

test('缺 id 时按 user@host:port 生成稳定 id', () => {
  const mark = seam.normalize(
    { host: '10.0.0.1', user: 'root', name: 'A1', group: '车队A' },
    [{ id: 'default', name: '默认分组' }],
  )
  assert.equal(mark.host, '10.0.0.1')
  assert.equal(mark.port, 22)
  assert.ok(mark.id.startsWith('bm-file-'), mark.id)
  assert.equal(seam.identity(mark), 'id:' + mark.id)
})

test('分组写名字时复用已有分组，没有才新建', () => {
  const groups = [{ id: 'default', name: '默认分组' }]
  const mark = seam.normalize({ host: 'h1', name: 'A2', group: '车队A' }, groups)
  assert.equal(groups.length, 2)
  assert.equal(groups[1].name, '车队A')
  assert.equal(mark.groupId, groups[1].id)

  const again = seam.normalize({ host: 'h2', name: 'A3', group: '车队A' }, groups)
  assert.equal(groups.length, 2)
  assert.equal(again.groupId, mark.groupId)
})

/* ------------------------------------------------------------------ */
/* 2. 合并：新条目写入 localStorage，分组一并补齐                      */
/* ------------------------------------------------------------------ */

test('文件里的书签和分组会合并进设置', async () => {
  reset()
  setSettings({ bookmarks: [], bookmarkGroups: [{ id: 'default', name: '默认分组' }] })
  mockFetch(
    JSON.stringify({
      bookmarkGroups: [{ id: 'fleet', name: '车队' }],
      bookmarks: [
        { id: 'b1', host: '10.0.0.1', name: 'A1', groupId: 'fleet', user: 'root' },
        { host: '10.0.0.2', name: 'A2', group: '车队' },
      ],
    }),
  )
  const changed = await seam.sync()
  assert.equal(changed, true)
  const settings = getSettings()
  assert.equal(settings.bookmarks.length, 2)
  assert.equal(settings.bookmarks[0].id, 'b1')
  assert.equal(settings.bookmarks[1].port, 22)
  assert.equal(settings.bookmarks[1].groupId, 'fleet')
  assert.ok(settings.bookmarkGroups.some((group) => group.id === 'fleet'))
  assert.ok(store.get(SEEN_KEY), '应记录上次导入的内容')
})

/* ------------------------------------------------------------------ */
/* 3. 幂等：文件没变时不再写设置，也不覆盖 UI 修改                     */
/* ------------------------------------------------------------------ */

test('文件没变时重复同步不写设置', async () => {
  const before = settingsWrites()
  const changed = await seam.sync()
  assert.equal(changed, false)
  assert.equal(settingsWrites(), before)
})

test('文件没变时 UI 改名不会被冲掉', async () => {
  const settings = getSettings()
  settings.bookmarks[0].name = 'A1-UI'
  setSettings(settings)
  const changed = await seam.sync()
  assert.equal(changed, false)
  assert.equal(getSettings().bookmarks[0].name, 'A1-UI')
})

/* ------------------------------------------------------------------ */
/* 4. 文件改了：只更新改过的条目，没改的 UI 修改保留                   */
/* ------------------------------------------------------------------ */

test('文件内容变化时更新对应条目', async () => {
  mockFetch(
    JSON.stringify({
      bookmarkGroups: [{ id: 'fleet', name: '车队' }],
      bookmarks: [
        { id: 'b1', host: '10.0.0.1', name: 'A1-文件', groupId: 'fleet', user: 'root' },
        { host: '10.0.0.2', name: 'A2', group: '车队' },
      ],
    }),
  )
  const changed = await seam.sync()
  assert.equal(changed, true)
  const settings = getSettings()
  assert.equal(settings.bookmarks[0].name, 'A1-文件')
  assert.equal(settings.bookmarks[1].name, 'A2')
})

/* ------------------------------------------------------------------ */
/* 5. 坏文件 / 文件不存在：静默跳过                                    */
/* ------------------------------------------------------------------ */

test('文件不是合法 JSON 时跳过', async () => {
  mockFetch('{oops')
  const before = JSON.stringify(getSettings())
  const changed = await seam.sync()
  assert.equal(changed, false)
  assert.equal(JSON.stringify(getSettings()), before)
})

test('文件不存在（404）时跳过', async () => {
  mockFetch('', false)
  const before = JSON.stringify(getSettings())
  const changed = await seam.sync()
  assert.equal(changed, false)
  assert.equal(JSON.stringify(getSettings()), before)
})

/* ------------------------------------------------------------------ */

await run()

async function run() {
  for (const [name, fn] of cases) {
    try {
      await fn()
      passed += 1
      console.log('ok   - ' + name)
    } catch (error) {
      failed += 1
      console.log('FAIL - ' + name)
      console.log('       ' + (error && error.message ? error.message : String(error)))
    }
  }
  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exitCode = 1
}
