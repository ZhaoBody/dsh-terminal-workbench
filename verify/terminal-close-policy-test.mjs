#!/usr/bin/env node
/**
 * 终端关闭意图策略回归。
 *
 * 覆盖三层：
 *   1. 启动裁剪：单会话最多 8 条、全局最多 64 条，无效值直接丢弃；
 *   2. 关闭判定：missingTerminal 不重试，failed / 未知状态保守保留；
 *   3. 关闭流程：missingTerminal 时抹掉核心刚写入的标记，其他情况保留。
 *
 * 只取 client.js 暴露的 `__dshTerminalWorkbenchClosePolicy` 测试缝，
 * 不加载 React / xterm / DOM 渲染。
 *
 * 运行：node verify/terminal-close-policy-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const store = new Map()
const localStorage = {
  get length() {
    return store.size
  },
  key(index) {
    return [...store.keys()][index] ?? null
  },
  getItem(key) {
    return store.has(key) ? store.get(key) : null
  },
  setItem(key, value) {
    store.set(key, String(value))
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

const seam = sandbox.window.__dshTerminalWorkbenchClosePolicy
assert.ok(seam, 'client.js 应暴露 __dshTerminalWorkbenchClosePolicy 测试缝')
const PREFIX = seam.prefix
assert.equal(PREFIX, 'dsh.terminal.close.v1.')

function seed(records) {
  store.clear()
  for (const record of records) store.set(PREFIX + record.id, JSON.stringify(record))
}
function markerIds() {
  return [...store.keys()]
    .filter((key) => key.startsWith(PREFIX))
    .map((key) => key.slice(PREFIX.length))
}
function request(id, sessionId, title = 'tab1') {
  return { sessionId, id, title }
}

let passed = 0
let failed = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

/* ------------------------------------------------------------------ */
/* 1. 启动裁剪                                                         */
/* ------------------------------------------------------------------ */

test('未超过上限时原样保留', () => {
  const records = []
  for (let session = 0; session < 2; session += 1) {
    for (let index = 0; index < 8; index += 1) {
      records.push(request(`s${session}-${index}`, `session-${session}`))
    }
  }
  seed(records)
  const report = seam.bound(localStorage)
  assert.equal(report.seen, 16)
  assert.equal(report.kept, 16)
  assert.equal(report.dropped, 0)
  assert.equal(report.invalid, 0)
  assert.equal(store.size, 16)
})

test('单会话 1269 条只保留最新的 8 条', () => {
  const records = []
  for (let index = 0; index < 1269; index += 1) {
    records.push(request(`id-${index}`, 'session-3c57aa5b'))
  }
  seed(records)
  const report = seam.bound(localStorage)
  assert.equal(report.seen, 1269)
  assert.equal(report.kept, 8)
  assert.equal(report.dropped, 1261)
  assert.equal(report.sessions, 1)
  assert.deepEqual(
    markerIds(),
    ['id-1261', 'id-1262', 'id-1263', 'id-1264', 'id-1265', 'id-1266', 'id-1267', 'id-1268'],
    '应保留插入顺序里最新的 8 条',
  )
})

test('全局超过 64 条时丢最旧的，保留最新 64 条', () => {
  const records = []
  for (let session = 0; session < 10; session += 1) {
    for (let index = 0; index < 8; index += 1) {
      records.push(request(`g${session}-${index}`, `session-${session}`))
    }
  }
  seed(records)
  const report = seam.bound(localStorage)
  assert.equal(report.seen, 80)
  assert.equal(report.kept, 64)
  assert.equal(report.dropped, 16)
  assert.equal(store.size, 64)
  assert.ok(!markerIds().includes('g0-0'), '最旧的应被丢弃')
  assert.ok(markerIds().includes('g9-7'), '最新的应保留')
})

test('无效 JSON 直接丢弃，不再每次启动报错', () => {
  store.clear()
  store.set(`${PREFIX}broken`, '{not-json')
  const report = seam.bound(localStorage)
  assert.equal(report.invalid, 1)
  assert.equal(report.kept, 0)
  assert.equal(store.size, 0)
})

test('key 与 id 不一致、缺 title 都按无效丢弃', () => {
  store.clear()
  store.set(`${PREFIX}key-a`, JSON.stringify(request('id-b', 'session-1')))
  store.set(`${PREFIX}no-title`, JSON.stringify({ sessionId: 'session-1', id: 'no-title' }))
  const report = seam.bound(localStorage)
  assert.equal(report.invalid, 2)
  assert.equal(store.size, 0)
})

test('同一条意图跨过一次启动还没成功，下次启动就丢弃', () => {
  seed([request('dead-1', 'session-1')])
  const first = seam.apply(localStorage)
  assert.equal(first.kept, 1, '第一次启动应保留并交给核心重放一次')
  assert.equal(first.expired, 0)
  assert.equal(markerIds().length, 1)
  assert.deepEqual(JSON.parse(store.get(seam.retryKey)), ['dead-1'])

  const second = seam.apply(localStorage)
  assert.equal(second.seen, 1)
  assert.equal(second.expired, 1, '第二次启动说明上次重放也没成功，应丢弃')
  assert.equal(second.kept, 0)
  assert.equal(markerIds().length, 0, '不应再永久重试')
})

test('首次启动之后新产生的关闭意图仍能重试一次', () => {
  seed([request('dead-1', 'session-1')])
  seam.apply(localStorage)
  store.set(`${PREFIX}fresh-1`, JSON.stringify(request('fresh-1', 'session-1')))

  const second = seam.apply(localStorage)
  assert.equal(second.expired, 1, '旧的应过期')
  assert.equal(second.kept, 1, '新的应保留一次')
  assert.deepEqual(markerIds(), ['fresh-1'])

  const third = seam.apply(localStorage)
  assert.equal(third.expired, 1)
  assert.equal(third.kept, 0)
  assert.equal(markerIds().length, 0)
})

test('重试预算本身损坏时按空处理，不影响启动', () => {
  seed([request('m-1', 'session-1')])
  store.set(seam.retryKey, '{broken')
  const report = seam.apply(localStorage)
  assert.equal(report.kept, 1)
  assert.equal(report.invalid, 0)
})

/* ------------------------------------------------------------------ */
/* 2. 关闭判定                                                         */
/* ------------------------------------------------------------------ */

function fakeView(id, snapshot) {
  return {
    id,
    state: {
      getSnapshot() {
        return snapshot
      },
    },
  }
}

test('missingTerminal：不重试，并记住终端 id', () => {
  const policy = seam.classify(fakeView('term-1', { issue: 'missingTerminal', phase: 'failed' }))
  assert.equal(policy.retry, false)
  assert.equal(policy.reason, 'missing')
  assert.equal(policy.terminalId, 'term-1')
})

test('failed 但没有 missingTerminal：保守保留重试', () => {
  const policy = seam.classify(fakeView('term-2', { phase: 'failed', error: 'network' }))
  assert.equal(policy.retry, true)
  assert.equal(policy.reason, 'failed')
  assert.equal(policy.terminalId, 'term-2')
})

test('没有视图（休眠标签）：保守保留重试', () => {
  const policy = seam.classify(undefined)
  assert.equal(policy.retry, true)
  assert.equal(policy.reason, 'unknown')
  assert.equal(policy.terminalId, undefined)
})

test('视图状态读取抛错时不影响关闭', () => {
  const broken = {
    id: 'term-3',
    state: {
      getSnapshot() {
        throw new Error('boom')
      },
    },
  }
  const policy = seam.classify(broken)
  assert.equal(policy.retry, true)
  assert.equal(policy.terminalId, 'term-3')
})

/* ------------------------------------------------------------------ */
/* 3. 关闭流程                                                         */
/* ------------------------------------------------------------------ */

function fakeCtx(view) {
  const saved = new Map()
  const removed = []
  const views = new Map()
  if (view !== undefined) views.set('session-1', new Map([['tab9', view]]))
  const ctx = {
    webTerminals: {
      views,
      requests: {
        save(record) {
          saved.set(record.id, record)
          store.set(`${PREFIX}${record.id}`, JSON.stringify(record))
        },
        remove(id) {
          saved.delete(id)
          removed.push(id)
          store.delete(`${PREFIX}${id}`)
        },
      },
      close(sessionId, key, contentId, fallbackTerminalId) {
        const bucket = views.get(sessionId)
        const terminal = bucket?.get(key)
        const id = terminal?.id ?? fallbackTerminalId
        if (id === undefined) return
        ctx.webTerminals.requests.save({ sessionId, id, title: terminal?.state.getSnapshot().title ?? key })
        bucket?.delete(key)
      },
    },
  }
  return { ctx, saved, removed }
}

test('关闭 missingTerminal 标签：核心写过标记也会被立即抹掉', () => {
  seed([])
  const view = fakeView('term-missing', { issue: 'missingTerminal', phase: 'failed' })
  const { ctx, saved, removed } = fakeCtx(view)
  const policy = seam.closeTab(ctx, 'session-1', { id: 'tab9', contentId: 'content-9' }, undefined)
  assert.equal(policy.retry, false)
  assert.equal(saved.size, 0, '不应留下重试记录')
  assert.deepEqual(removed, ['term-missing'])
  assert.equal(store.size, 0, 'localStorage 里也不应残留')
})

test('关闭 failed 标签：保留重试记录', () => {
  seed([])
  const view = fakeView('term-failed', { phase: 'failed', error: 'network' })
  const { ctx, saved, removed } = fakeCtx(view)
  const policy = seam.closeTab(ctx, 'session-1', { id: 'tab9', contentId: 'content-9' }, undefined)
  assert.equal(policy.retry, true)
  assert.equal(saved.size, 1)
  assert.deepEqual(removed, [])
  assert.equal(store.size, 1)
})

test('关闭没有视图的休眠标签：用 fallback terminalId 保留重试', () => {
  seed([])
  const { ctx, saved, removed } = fakeCtx(undefined)
  const policy = seam.closeTab(ctx, 'session-1', { id: 'tab9', contentId: 'content-9' }, 'term-dormant')
  assert.equal(policy.retry, true)
  assert.equal(saved.size, 1)
  assert.equal(saved.get('term-dormant').title, 'tab9')
  assert.deepEqual(removed, [])
})

test('核心没暴露视图表时保守处理，不误删标记', () => {
  seed([])
  const saved = new Map()
  const ctx = {
    webTerminals: {
      requests: {
        save(record) {
          saved.set(record.id, record)
        },
        remove() {
          throw new Error('不应调用 remove')
        },
      },
      close(sessionId, key, contentId, fallbackTerminalId) {
        if (fallbackTerminalId === undefined) return
        ctx.webTerminals.requests.save({ sessionId, id: fallbackTerminalId, title: key })
      },
    },
  }
  const policy = seam.closeTab(ctx, 'session-1', { id: 'tab9', contentId: 'content-9' }, 'term-safe')
  assert.equal(policy.retry, true)
  assert.equal(saved.size, 1)
})

/* ------------------------------------------------------------------ */

for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
