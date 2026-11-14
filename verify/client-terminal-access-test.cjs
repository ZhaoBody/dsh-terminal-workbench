#!/usr/bin/env node
/**
 * 终端访问角标回归。
 *
 * 只从 client.js 取 `__twbTerminalAccess` 测试缝，不加载 xterm / DOM。
 * 覆盖：状态→角标映射、快照缓存与旧会话隔离、无授权/撤销入口。
 *
 * 运行：node verify/client-terminal-access-test.cjs
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
const sessionStorage = {
  getItem() { return null },
  setItem() {},
  removeItem() {},
}
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage,
    sessionStorage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(fn) { return setTimeout(fn, 0) },
    cancelAnimationFrame(id) { clearTimeout(id) },
  },
  document: {
    visibilityState: 'visible',
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
const access = definition.factory(requireStub).__twbTerminalAccess
assert.ok(access, 'client.js 应导出 __twbTerminalAccess 测试缝')

let passed = 0
let failed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

function snapshot(terminals, policy) {
  return { ok: true, policy: policy ?? 'ask', terminals }
}

function item(id, extra) {
  return Object.assign({ id, title: id, state: 'running', own: false, access: 'read-only' }, extra)
}

/* ------------------------------------------------------------------ */

test('角标：助手专属 / 可写 / 需审批 / 已退出 / 可读', () => {
  assert.equal(access.badge({ own: true, access: 'own', state: 'running' }, 't1').text, '助手专属')
  assert.equal(access.badge({ own: true, access: 'read-only', state: 'exited' }, 't1').text, '已退出')
  assert.equal(access.badge(item('t1', { access: 'writable' }), 't1').text, '可写')
  assert.equal(access.badge(item('t1', { access: 'approval' }), 't1').text, '需审批')
  assert.equal(access.badge(item('t1'), 't1').text, '可读')
  assert.equal(access.badge(item('t1', { state: 'exited' }), 't1').text, '已退出')
})

test('角标不再带撤销语义', () => {
  const badge = access.badge(item('t1', { access: 'approval' }), 't1')
  assert.equal('revocable' in badge, false)
  assert.doesNotMatch(code, /accessBadge\.revocable/)
  assert.doesNotMatch(code, /revokeTerminalAccess/)
})

test('角标：缺少 terminalId 或状态条目时不渲染', () => {
  assert.equal(access.badge(item('t1'), ''), undefined)
  assert.equal(access.badge(item('t1'), undefined), undefined)
  assert.equal(access.badge(undefined, 't1'), undefined)
})

test('终端身份：导航参数优先，其次已挂载视图，最后持久绑定', () => {
  assert.equal(access.resolveTerminalId({ terminalId: 'p' }, { id: 'v' }, 'b'), 'p')
  assert.equal(access.resolveTerminalId({}, { id: 'v' }, 'b'), 'v')
  assert.equal(access.resolveTerminalId(undefined, undefined, 'b'), 'b')
  assert.equal(access.resolveTerminalId({}, undefined, ''), undefined)
  assert.equal(access.resolveTerminalId({ terminalId: '' }, { id: '' }, undefined), undefined)
})

test('新建终端只把导航参数当恢复身份，角标从视图/绑定补齐', () => {
  assert.match(code, /restoredTerminalId\(sessionId, key\)/)
  assert.match(code, /ctx\.webTerminals\.views/)
  assert.match(code, /ctx\.webTerminals\.bindings/)
})

test('快照只保留当前会话，旧会话迟到响应不会切回去', () => {
  access.reset()
  access.apply('s1', snapshot([item('tab-1', { access: 'approval' })]))
  assert.equal(access.entry('s1', 'tab-1').access, 'approval')
  assert.equal(access.snapshot('s1').terminals.length, 1)

  access.apply('s2', snapshot([item('tab-2')]))
  assert.equal(access.entry('s2', 'tab-2'), undefined)
  assert.equal(access.snapshot('s2').terminals.length, 0)
  assert.equal(access.entry('s1', 'tab-1').access, 'approval')
})

test('测试缝没有 grant / authorize / revoke / clientId 入口', () => {
  assert.equal(typeof access.grant, 'undefined')
  assert.equal(typeof access.authorize, 'undefined')
  assert.equal(typeof access.revoke, 'undefined')
  assert.equal(typeof access.clientId, 'undefined')
})

test('标题注入 sessionId / terminalId，角标带 data-access 标记', () => {
  assert.match(code, /sessionId,\s*\n\s*terminalId: \(key\) => terminalId\(sessionId, key\)/)
  assert.match(code, /className: 'tp-access tp-access-' \+ accessBadge\.tone/)
  assert.match(code, /'data-access': accessBadge\.key/)
})

test('访问请求只带 sessionId，不再带页面实例 id 与连接代际', () => {
  assert.match(code, /TERMINAL_ACCESS_URL \+ '\?sessionId='/)
  assert.doesNotMatch(code, /TERMINAL_ACCESS_CLIENT_ID/)
  assert.doesNotMatch(code, /&generation=/)
  assert.doesNotMatch(code, /generation\.subscribe/)
})

test('boot.gif 报到不再携带 client 参数', () => {
  assert.match(code, /boot\.gif\?t=" \+ Date\.now\(\)/)
  assert.doesNotMatch(code, /&client=/)
})

/* ------------------------------------------------------------------ */

async function main() {
  for (const [name, fn] of cases) {
    try {
      await fn()
      passed += 1
      console.log('ok   - ' + name)
    } catch (error) {
      failed += 1
      console.log('FAIL - ' + name)
      console.log('       ' + (error && error.message ? error.message : error))
    }
  }
  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
