#!/usr/bin/env node
/**
 * SSH 并发 / IPv6 转发 / 转发失败闸门回归（复核 P1）。
 *
 * 只从 client.js 取 `__twbSsh` 测试缝，不加载 xterm / DOM。
 * 运行：node verify/client-p1-test.cjs
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
const ssh = definition.factory(requireStub).__twbSsh
assert.ok(ssh, 'client.js 应导出 __twbSsh 测试缝')

let passed = 0
let failed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

function bookmark(extra) {
  return Object.assign({
    host: 'example.com',
    user: 'ops',
    port: 22,
    auth: 'agent',
  }, extra)
}

/* ------------------------------------------------------------------ */
/* 1. 转发解析：IPv6 方括号不能当分隔符                                */
/* ------------------------------------------------------------------ */

test('IPv6 目标：8080:[::1]:80 切成 bind=8080 / dest=[::1]:80', () => {
  assert.deepEqual(ssh.parseForwardSpec('L 8080:[::1]:80'), {
    flag: '-L',
    text: '8080:[::1]:80',
  })
})

test('IPv6 两端：[::1]:8080:[::2]:80 完整保留', () => {
  assert.deepEqual(ssh.parseForwardSpec('-L [::1]:8080:[::2]:80'), {
    flag: '-L',
    text: '[::1]:8080:[::2]:80',
  })
})

test('IPv6 对象写法原样通过', () => {
  assert.deepEqual(
    ssh.parseForwardSpec({ type: 'L', bind: '[::1]:8080', dest: '[::2]:80' }),
    { flag: '-L', text: '[::1]:8080:[::2]:80' },
  )
})

test('普通 IPv4 转发仍按最右两段切', () => {
  assert.deepEqual(ssh.parseForwardSpec('L 127.0.0.1:8080:db:5432'), {
    flag: '-L',
    text: '127.0.0.1:8080:db:5432',
  })
})

test('空格两段式不受影响', () => {
  assert.deepEqual(ssh.parseForwardSpec('L 8080 db:5432'), {
    flag: '-L',
    text: '8080:db:5432',
  })
})

test('坏数据仍被丢弃', () => {
  assert.strictEqual(ssh.parseForwardSpec('L'), null)
  assert.strictEqual(ssh.parseForwardSpec('X 8080:db:5432'), null)
  assert.strictEqual(ssh.parseForwardSpec('L 8080'), null)
  assert.deepEqual(ssh.forwardArgsOf(['L 8080:[::1]:80', 'bad', null]), [
    ['-L', '8080:[::1]:80'],
  ])
})

/* ------------------------------------------------------------------ */
/* 2. ssh 命令：转发失败必须让 ssh 自己失败                            */
/* ------------------------------------------------------------------ */

test('配了转发时拼入 ExitOnForwardFailure=yes', () => {
  const command = ssh.sshCommand(bookmark({ forwards: ['L 8080:[::1]:80'] }))
  assert.ok(command.includes('-o ExitOnForwardFailure=yes'), command)
  assert.ok(command.includes('-L'), command)
  assert.ok(command.includes('8080:[::1]:80'), command)
})

test('没配转发时不多加 ExitOnForwardFailure', () => {
  const command = ssh.sshCommand(bookmark())
  assert.ok(!command.includes('ExitOnForwardFailure'), command)
})

/* ------------------------------------------------------------------ */
/* 3. askpass：并发会话不能共用一个固定文件                            */
/* ------------------------------------------------------------------ */

test('askpass 文件名按 shell PID 分开', () => {
  const boot = ssh.askpassBootstrap('p@ss word')
  assert.strictEqual(boot.script, '$HOME/.dsh-askpass.$$.sh')
  assert.ok(boot.create.includes('$HOME/.dsh-askpass.$$.sh'), boot.create)
  assert.deepEqual(boot.env, [
    'SSH_ASKPASS=$HOME/.dsh-askpass.$$.sh',
    'SSH_ASKPASS_REQUIRE=force',
  ])
})

test('askpass 密码仍按单引号转义并 base64 投递', () => {
  const boot = ssh.askpassBootstrap("a'b")
  const content = "#!/bin/sh\nprintf '%s\\n' 'a'\\''b'\n"
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  assert.ok(boot.create.includes(encoded), boot.create)
  assert.ok(boot.create.includes('base64 -d'), boot.create)
  assert.ok(!boot.create.includes("a'b"), boot.create)
})

test('密码会话的 create / env / rm 指向同一个模板', () => {
  const command = ssh.sshCommand(bookmark({ auth: 'password', password: 'secret' }))
  assert.ok(command.includes('> $HOME/.dsh-askpass.$$.sh'), command)
  assert.ok(command.includes('SSH_ASKPASS=$HOME/.dsh-askpass.$$.sh'), command)
  assert.ok(command.includes('; rm -f $HOME/.dsh-askpass.$$.sh'), command)
})

/* ------------------------------------------------------------------ */

for (const [name, fn] of cases) {
  try {
    fn()
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
