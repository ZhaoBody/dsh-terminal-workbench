#!/usr/bin/env node
/**
 * 网页标签地址栏回归（纯字符串，不加载 DOM / iframe）。
 *
 * 右栏加号菜单新增“网页”标签后，地址栏要能区分：
 *   - 完整 URL / localhost / 域名 → 直接打开；
 *   - 普通文本 → 走搜索；
 * 同时主输入框只有在明确像网址时才开网页标签，避免把 `ls -la`
 * 当网址送到搜索页。
 *
 * 运行：node verify/web-tab-test.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')

const CLIENT = path.join(__dirname, '..', 'client.js')
const code = fs.readFileSync(CLIENT, 'utf8')

let definition
const storage = new Map()
const localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
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
const web = exported.__twbWeb
assert.ok(web, 'client.js 应导出 __twbWeb 测试缝')

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

check('完整 https URL 原样保留', () => {
  assert.strictEqual(web.normalizeWebUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
})

check('完整 http URL 原样保留', () => {
  assert.strictEqual(web.normalizeWebUrl('http://example.com'), 'http://example.com')
})

check('localhost 补 http://', () => {
  assert.strictEqual(web.normalizeWebUrl('localhost:3080/x'), 'http://localhost:3080/x')
  assert.strictEqual(web.normalizeWebUrl('localhost'), 'http://localhost')
})

check('127.0.0.1 补 http://', () => {
  assert.strictEqual(web.normalizeWebUrl('127.0.0.1:3080'), 'http://127.0.0.1:3080')
})

check('域名补 https://', () => {
  assert.strictEqual(web.normalizeWebUrl('example.com/a'), 'https://example.com/a')
  assert.strictEqual(web.normalizeWebUrl('www.example.com'), 'https://www.example.com')
})

check('普通文本走 Bing 搜索', () => {
  assert.strictEqual(
    web.normalizeWebUrl('hello world'),
    'https://www.bing.com/search?q=hello%20world',
  )
})

check('空白输入返回空串', () => {
  assert.strictEqual(web.normalizeWebUrl('   '), '')
  assert.strictEqual(web.normalizeWebUrl(undefined), '')
})

check('主输入框：明确网址才开网页', () => {
  assert.strictEqual(web.looksLikeUrl('https://example.com'), true)
  assert.strictEqual(web.looksLikeUrl('www.example.com'), true)
  assert.strictEqual(web.looksLikeUrl('localhost:3000'), true)
  assert.strictEqual(web.looksLikeUrl('127.0.0.1:3080'), true)
})

check('主输入框：shell 命令不误判成网址', () => {
  assert.strictEqual(web.looksLikeUrl('ls -la'), false)
  assert.strictEqual(web.looksLikeUrl('git status'), false)
  assert.strictEqual(web.looksLikeUrl('foo.bar'), false)
  assert.strictEqual(web.looksLikeUrl('./run.sh'), false)
  assert.strictEqual(web.looksLikeUrl(''), false)
})

check('地址副本按会话 + 标签隔离', () => {
  assert.strictEqual(web.webUrlKey('s1', 'tab3'), 'dsh-terminal-workbench.webUrl.s1.tab3')
  assert.notStrictEqual(web.webUrlKey('s1', 'tab3'), web.webUrlKey('s2', 'tab3'))
  assert.notStrictEqual(web.webUrlKey('s1', 'tab3'), web.webUrlKey('s1', 'tab4'))
})

check('地址副本可读写，关闭标签后清除', () => {
  storage.clear()
  web.storeWebUrl('s1', 'tab9', 'https://example.com/a')
  assert.strictEqual(web.readStoredWebUrl('s1', 'tab9'), 'https://example.com/a')
  web.forgetWebUrl('s1', 'tab9')
  assert.strictEqual(web.readStoredWebUrl('s1', 'tab9'), '')
  assert.strictEqual(storage.has('dsh-terminal-workbench.webUrl.s1.tab9'), false)
})

check('地址副本按标签隔离，互不覆盖', () => {
  storage.clear()
  web.storeWebUrl('s1', 'tab1', 'https://a.example')
  web.storeWebUrl('s1', 'tab2', 'https://b.example')
  assert.strictEqual(web.readStoredWebUrl('s1', 'tab1'), 'https://a.example')
  assert.strictEqual(web.readStoredWebUrl('s1', 'tab2'), 'https://b.example')
  web.forgetWebUrl('s1', 'tab1')
  assert.strictEqual(web.readStoredWebUrl('s1', 'tab2'), 'https://b.example')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
