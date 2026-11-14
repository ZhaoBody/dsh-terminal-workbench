#!/usr/bin/env node
/**
 * OSC 133 命令块（S4）无头测试。
 *
 * 这里不加载 xterm，也不碰 DOM：从 client.js 的模块工厂里取出
 * `__twbBlocks`（OSC 133 状态机 + 纯函数），用假 buffer / 假 marker 驱动。
 * 覆盖：标记解析、命令截取、块生命周期、失败块、D 缺失、marker 漂移、
 * 跳转环回、标签销毁清理。
 *
 * 运行：node verify/client-blocks-test.cjs
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const assert = require('assert')
const { execFileSync } = require('child_process')

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
const blocks = exported.__twbBlocks
assert.ok(blocks, 'client.js 应导出 __twbBlocks 测试缝')

let passed = 0
let failed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

/* ------------------------------------------------------------------ */
/* 假终端：行数组 + 绝对行号 marker，支持模拟回滚裁行                    */
/* ------------------------------------------------------------------ */

function makeTerm(rows) {
  rows = rows === undefined ? 24 : rows
  const lines = []
  const markers = new Set()
  const buffer = {
    baseY: 0,
    cursorY: 0,
    cursorX: 0,
    viewportY: 0,
    getLine(y) {
      if (y < 0 || y >= lines.length) return undefined
      const text = lines[y]
      return {
        translateToString(trimRight) {
          return trimRight ? text.replace(/[ \t]+$/g, '') : text
        },
      }
    },
  }
  const term = {
    rows,
    cols: 80,
    buffer: { active: buffer },
    registerMarker(offset) {
      /* xterm 的 offset 相对当前光标；负值用来把块首锚回提示符行。 */
      const marker = {
        line: buffer.baseY + buffer.cursorY + (offset === undefined ? 0 : offset),
        disposed: false,
        dispose() {
          marker.disposed = true
          marker.line = -1
          markers.delete(marker)
        },
      }
      markers.add(marker)
      return marker
    },
  }
  function ensureLine(y) {
    while (lines.length <= y) lines.push('')
  }
  const api = {
    term,
    buffer,
    markers,
    send(data) { return blocks.handleOsc133('tab-1', term, data) },
    write(text) {
      const absolute = buffer.baseY + buffer.cursorY
      ensureLine(absolute)
      lines[absolute] = lines[absolute] + text
      buffer.cursorX += text.length
    },
    newline() {
      buffer.cursorY += 1
      buffer.cursorX = 0
      ensureLine(buffer.baseY + buffer.cursorY)
    },
    setCursor(line, column) {
      buffer.baseY = 0
      buffer.cursorY = line
      buffer.cursorX = column === undefined ? 0 : column
      ensureLine(line)
    },
    trim(count) {
      lines.splice(0, count)
      buffer.baseY = Math.max(0, buffer.baseY - count)
      for (const marker of markers) {
        marker.line -= count
        if (marker.line < 0) {
          marker.line = -1
          marker.disposed = true
          markers.delete(marker)
        }
      }
    },
    prompt(text) {
      api.send('A')
      api.write(text)
      api.send('B')
    },
    run(command, exitCode) {
      api.write(command)
      api.newline()
      api.send('C')
      const block = blocks.terminalBlocksOf('tab-1').slice(-1)[0]
      if (block === undefined) throw new Error('C 之后应该有正在执行的块')
      api.send('D;' + exitCode)
      return block
    },
    lines,
  }
  return api
}

function resetBlocks() {
  blocks.forgetTerminalBlocks('tab-1')
  blocks.forgetTerminalBlocks('tab-2')
}

/* ------------------------------------------------------------------ */

test('parseOsc133 识别 A/B/C/D 与退出码', () => {
  /* 对象来自 vm 上下文，原型不同；按 JSON 值比较。 */
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepStrictEqual(plain(blocks.parseOsc133('A')), { kind: 'A', payload: '' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('B')), { kind: 'B', payload: '' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('C')), { kind: 'C', payload: '' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('D;0')), { kind: 'D', exitCode: 0, payload: '0' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('D;130')), { kind: 'D', exitCode: 130, payload: '130' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('D')), { kind: 'D', exitCode: null, payload: '' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('D;oops')), { kind: 'D', exitCode: null, payload: 'oops' })
  assert.deepStrictEqual(plain(blocks.parseOsc133('D;1;extra')), { kind: 'D', exitCode: 1, payload: '1;extra' })
  assert.strictEqual(blocks.parseOsc133(''), null)
  assert.strictEqual(blocks.parseOsc133('X'), null)
  assert.strictEqual(blocks.parseOsc133('Dx;1'), null)
})

test('formatBlockDuration 覆盖毫秒/秒/分钟边界', () => {
  assert.strictEqual(blocks.formatBlockDuration(0), '0ms')
  assert.strictEqual(blocks.formatBlockDuration(999), '999ms')
  assert.strictEqual(blocks.formatBlockDuration(1000), '1.0s')
  assert.strictEqual(blocks.formatBlockDuration(9999), '10.0s')
  assert.strictEqual(blocks.formatBlockDuration(10000), '10s')
  assert.strictEqual(blocks.formatBlockDuration(60000), '1m00s')
  assert.strictEqual(blocks.formatBlockDuration(65000), '1m05s')
  assert.strictEqual(blocks.formatBlockDuration(-1), '')
  assert.strictEqual(blocks.formatBlockDuration(NaN), '')
})

test('extractCommandBetween 从提示符末尾截到命令末尾', () => {
  const buffer = {
    getLine(y) {
      const rows = ['$ echo hi', 'second line', 'tail   ']
      if (rows[y] === undefined) return undefined
      return { translateToString(trimRight) { return trimRight ? rows[y].replace(/[ \t]+$/g, '') : rows[y] } }
    },
  }
  assert.strictEqual(blocks.extractCommandBetween(buffer, 0, 2, 0, 9), 'echo hi')
  /* 同一行截取：toX 是绝对列，不是切掉 fromX 后的长度。 */
  assert.strictEqual(blocks.extractCommandBetween(buffer, 0, 2, 0, 5), 'ech')
  assert.strictEqual(blocks.extractCommandBetween(buffer, 0, 2, 2, 4), 'echo hi\nsecond line\ntail')
  assert.strictEqual(blocks.extractCommandBetween(buffer, 0, 2, 1, 0), 'echo hi')
  assert.strictEqual(blocks.extractCommandBetween(buffer, 5, 0, 5, 0), '')
})

test('完整生命周期：A/B/C/D 生成 ok 块，命令与行号正确', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.write('echo hi')
  t.newline()
  t.send('C')
  t.write('hi')
  t.newline()
  assert.strictEqual(t.send('D;0'), true)

  const list = blocks.terminalBlocksOf('tab-1')
  assert.strictEqual(list.length, 1)
  const block = list[0]
  assert.strictEqual(block.command, 'echo hi')
  assert.strictEqual(block.exitCode, 0)
  assert.strictEqual(blocks.blockStateOf(block), 'ok')
  assert.strictEqual(blocks.blockStartLineOf(block), 0)
  assert.strictEqual(blocks.blockEndLineOf(block, t.term), 2)
  assert.ok(block.endedAt !== undefined)
  assert.ok(block.id > 0)
})

test('下一提示符的 A 回退上一块的结束行，边距不吃进提示符', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.write('echo hi')
  t.newline()
  t.send('C')
  t.write('hi')
  t.newline()
  t.send('D;0')
  const first = blocks.terminalBlocksOf('tab-1')[0]
  assert.strictEqual(blocks.blockEndLineOf(first, t.term), 2)

  /* 下一提示符正好落在 D 记录的空行上：第一块应收回到输出末行 1。 */
  t.prompt('$ ')
  assert.strictEqual(blocks.blockEndLineOf(first, t.term), 1)
  assert.strictEqual(first.endLine, 1)

  t.run('true', 0)
  const second = blocks.terminalBlocksOf('tab-1')[1]
  assert.strictEqual(blocks.blockStartLineOf(second), 2)
  assert.strictEqual(blocks.blockEndLineOf(second, t.term), 3)
})

test('D;N 非零退出码生成失败块', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.run('false', 1)
  const block = blocks.terminalBlocksOf('tab-1')[0]
  assert.strictEqual(block.command, 'false')
  assert.strictEqual(block.exitCode, 1)
  assert.strictEqual(blocks.blockStateOf(block), 'fail')
})

test('首个提示符的 D 没有 C，不生成块', () => {
  resetBlocks()
  const t = makeTerm()
  t.send('D;0')
  assert.strictEqual(blocks.terminalBlocksOf('tab-1').length, 0)
})

test('下一条 C 到来时，未收到 D 的块标记为 interrupted', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.write('sleep 99')
  t.newline()
  t.send('C')
  t.send('C')
  const list = blocks.terminalBlocksOf('tab-1')
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].reason, 'interrupted')
  assert.strictEqual(list[0].exitCode, undefined)
  assert.strictEqual(blocks.blockStateOf(list[0]), 'unknown')
  assert.strictEqual(list[1].endedAt, undefined)
  assert.strictEqual(blocks.blockStateOf(list[1]), 'running')
})

test('C 的 payload 作为命令文本兜底', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.send('C;echo payload')
  t.send('D;0')
  const block = blocks.terminalBlocksOf('tab-1')[0]
  assert.strictEqual(block.command, 'echo payload')
})

test('空命令也会形成块（命令文本为空）', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.newline()
  t.send('C')
  t.send('D;0')
  const block = blocks.terminalBlocksOf('tab-1')[0]
  assert.strictEqual(block.command, '')
  assert.strictEqual(block.exitCode, 0)
})

test('块跳转：前后查找、首尾环回', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.run('true', 0)
  t.prompt('$ ')
  t.run('false', 1)

  const list = blocks.terminalBlocksOf('tab-1')
  assert.strictEqual(list.length, 2)
  const first = list[0]
  const second = list[1]

  assert.strictEqual(blocks.neighborTerminalBlock('tab-1', blocks.blockStartLineOf(first), 1), second)
  assert.strictEqual(blocks.neighborTerminalBlock('tab-1', blocks.blockStartLineOf(second), -1), first)
  /* 第一个块再往前：环回最后一个；最后一个再往后：环回第一个。 */
  assert.strictEqual(blocks.neighborTerminalBlock('tab-1', blocks.blockStartLineOf(first), -1), second)
  assert.strictEqual(blocks.neighborTerminalBlock('tab-1', blocks.blockStartLineOf(second), 1), first)
  /* 视口顶部正好是第一个块首行：向下应该去第二个，而不是原地不动。 */
  assert.strictEqual(blocks.neighborTerminalBlock('tab-1', 0, 1), second)
  assert.strictEqual(blocks.neighborTerminalBlock('tab-empty', 0, 1), undefined)
})

test('marker 锚定：回滚裁行后块行号跟着内容走', () => {
  resetBlocks()
  const t = makeTerm()
  t.setCursor(10, 0)
  t.prompt('$ ')
  t.run('true', 0)
  const block = blocks.terminalBlocksOf('tab-1')[0]
  assert.strictEqual(blocks.blockStartLineOf(block), 10)

  t.trim(5)
  /* 裸行号仍是 10，但 marker 已变成 5——应以 marker 为准。 */
  assert.strictEqual(block.startLine, 10)
  assert.strictEqual(block.startMarker.line, 5)
  assert.strictEqual(blocks.blockStartLineOf(block), 5)
})

test('forgetTerminalBlocks 清空块并释放 marker', () => {
  resetBlocks()
  const t = makeTerm()
  t.prompt('$ ')
  t.run('true', 0)
  const block = blocks.terminalBlocksOf('tab-1')[0]
  const start = block.startMarker
  const end = block.endMarker
  blocks.forgetTerminalBlocks('tab-1')
  assert.strictEqual(blocks.terminalBlocksOf('tab-1').length, 0)
  assert.strictEqual(start.disposed, true)
  assert.strictEqual(end.disposed, true)
})

test('未知 kind 返回 false，不污染块表', () => {
  resetBlocks()
  const t = makeTerm()
  assert.strictEqual(t.send('Z;1'), false)
  assert.strictEqual(t.send(''), false)
  assert.strictEqual(blocks.terminalBlocksOf('tab-1').length, 0)
})

test('远端 bootstrap 注入 OSC133，且不覆盖用户 PROMPT_COMMAND / precmd 钩子', () => {
  const shell = exported.__twbShell
  assert.ok(shell && typeof shell.remoteBootstrap === 'function', '应导出 remoteBootstrap 测试缝')
  const script = shell.remoteBootstrap('/tmp/twb dir')
  /* 四段标记与 OSC7 都在。 */
  assert.ok(script.includes(']133;A\\007'))
  assert.ok(script.includes(']133;B\\007'))
  assert.ok(script.includes(']133;C\\007'))
  assert.ok(script.includes(']133;D;%s\\007'))
  assert.ok(script.includes(']7;%s\\007'))
  /* bash：prepend PROMPT_COMMAND，而不是整条覆盖。 */
  assert.ok(script.includes('PROMPT_COMMAND=(__twb_precmd "${PROMPT_COMMAND[@]}")'))
  assert.ok(script.includes('PROMPT_COMMAND="__twb_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"'))
  assert.ok(script.includes("PS0='\\033]133;C\\007'"))
  /* zsh：走钩子数组，不定义同名 precmd() 把用户实现盖掉。 */
  assert.ok(script.includes('precmd_functions=(__twb_precmd ${precmd_functions:#__twb_precmd})'))
  assert.ok(script.includes('preexec_functions=(__twb_preexec ${preexec_functions:#__twb_preexec})'))
  assert.ok(!/^precmd\(\) \{/m.test(script), '不应覆盖用户 precmd 函数')
  /* 临时 rcfile 读完后自删，不在远端 $HOME 里越积越多。 */
  assert.ok(script.includes('rm -f "$HOME/.dsh-twb-bashrc.$$"'))
  /* 生成物必须是合法 bash（zsh 分支此时只是 heredoc 文本）。 */
  const file = path.join(os.tmpdir(), 'twb-bootstrap-' + process.pid + '.sh')
  fs.writeFileSync(file, script)
  try {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' })
  } finally {
    fs.unlinkSync(file)
  }
})

/* ------------------------------------------------------------------ */

for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log('ok   - ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL - ' + name)
    console.error(String(error && error.stack ? error.stack : error))
  }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
