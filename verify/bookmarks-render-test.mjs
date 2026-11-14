#!/usr/bin/env node
/**
 * 书签分组渲染回归（不依赖 React/DOM）。
 *
 * 用与 react/jsx-runtime 同签名的假实现（jsx(type, props, key)）驱动
 * `renderBookmarkGroups`，检查：
 *   - 分组容器把分组放进 props.children，而不是第三个参数（key）；
 *   - 分组标题、计数、书签网格都真实带子节点；
 *   - 没有书签时回退到 emptyText。
 *
 * 运行：node verify/bookmarks-render-test.mjs
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

/* 与 react/jsx-runtime 相同的签名：第三个参数是 key，children 只在 props 里。 */
const jsx = (type, props, key) => ({ type, props: props || {}, key })
const jsxs = jsx

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
  if (name === 'react/jsx-runtime') return { jsx, jsxs }
  if (name === '@deepseek-ai/dsh-client-store') return { defineStore() {} }
  return {}
}
definition.factory(requireStub)

const seam = sandbox.window.__dshTerminalWorkbenchBookmarks
assert.ok(seam, 'client.js 应暴露 __dshTerminalWorkbenchBookmarks 测试缝')
assert.equal(typeof seam.render, 'function', '测试缝应暴露 render')

const SETTINGS_KEY = 'dsh-terminal-workbench.settings'

function setSettings(settings) {
  store.set(SETTINGS_KEY, JSON.stringify(settings))
}

let passed = 0
let failed = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out))
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.props && node.props.children, predicate, out)
  return out
}

const groups = [
  { id: 'default', name: '默认分组' },
  { id: 'g-mw1', name: 'MW1' },
]
const bookmarks = [
  { id: 'a', name: '237', host: '10.141.37.10', port: '22', user: 'ubuntu', groupId: 'g-mw1' },
  { id: 'b', name: '204', host: '10.141.4.10', port: '22', user: 'ubuntu', groupId: 'g-mw1' },
  { id: 'c', name: '海西6', host: '10.41.69.10', port: '22', user: 'ubuntu', groupId: 'default' },
]

test('有书签时渲染分组与网格', () => {
  setSettings({ bookmarks, bookmarkGroups: groups })
  const tree = seam.render({ onOpen() {} })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'wb-bookmark-groups')
  assert.ok(Array.isArray(tree.props.children), '分组必须是 props.children')
  assert.equal(tree.props.children.length, 2)
  assert.equal(tree.key, undefined)

  const groupNodes = tree.props.children
  assert.equal(groupNodes[0].props.className, 'wb-bookmark-group')
  assert.equal(groupNodes[0].props['data-bookmark-group'], 'default')

  const firstChildren = groupNodes[0].props.children
  assert.ok(Array.isArray(firstChildren) && firstChildren.length === 2)
  const title = firstChildren[0]
  assert.equal(title.props.className, 'wb-pop-groupname')
  assert.equal(textOf(title), '▾默认分组1')

  const grid = firstChildren[1]
  assert.equal(grid.props.className, 'wb-bookmark-grid')
  assert.equal(grid.props.children.length, 1)
  assert.equal(textOf(grid), '海西6')

  const mw1Grid = groupNodes[1].props.children[1]
  assert.equal(mw1Grid.props.children.length, 2)
  assert.equal(textOf(mw1Grid), '237204')
})

test('搜索命中时只保留匹配分组', () => {
  setSettings({ bookmarks, bookmarkGroups: groups })
  const tree = seam.render({ onOpen() {}, keyword: '237' })
  assert.equal(tree.props.children.length, 1)
  assert.equal(tree.props.children[0].props['data-bookmark-group'], 'g-mw1')
  assert.equal(textOf(tree), '▾MW11237')
})

test('空书签回退到 emptyText', () => {
  setSettings({ bookmarks: [], bookmarkGroups: groups })
  const tree = seam.render({ onOpen() {}, emptyText: '在设置里添加书签' })
  assert.equal(tree.props.className, 'wb-pop-empty')
  assert.equal(textOf(tree), '在设置里添加书签')
})

test('折叠分组不渲染网格', () => {
  setSettings({ bookmarks, bookmarkGroups: groups })
  const tree = seam.render({ onOpen() {}, collapsedGroups: ['g-mw1'] })
  const mw1 = tree.props.children[1]
  assert.equal(mw1.props['data-folded'], 'true')
  assert.equal(textOf(mw1), '▸MW12')
  assert.equal(findAll(mw1, (node) => node.props && node.props.className === 'wb-bookmark-grid').length, 0)
})

for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
