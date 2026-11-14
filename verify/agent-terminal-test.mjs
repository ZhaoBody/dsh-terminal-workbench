#!/usr/bin/env node
/**
 * 外部终端访问权限 + 专属终端重建回归测试。
 *
 * 两块被测逻辑都在 lib/agent-terminal.js：
 *   1. `accessOf` / `/terminal-access` / pre-execute 闸门（权限跟随 DSH）；
 *   2. `ensureOwnTerminal`：专属终端退出后换新 id 重建，不卡在 exited 实例上。
 *
 * 不加载真实 dsh 宿主：用假 controller 复刻 `create` 的幂等语义、
 * `close` 的 closedIds 语义和会话终端上限，再用假 ctx 驱动插件注册。
 *
 * 运行：node verify/agent-terminal-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const moduleUrl = pathToFileURL(path.join(here, '..', 'lib', 'agent-terminal.js')).href
const mod = await import(moduleUrl)

let passed = 0
let failed = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

const agent = { id: 'session-abc123', session: { id: 'session-abc123' } }
const ownBase = mod.ownTerminalBase(agent)

function terminal(id, extra = {}) {
  return {
    id,
    title: 'zsh',
    shell: 'bash',
    cwd: '/tmp',
    cols: 120,
    rows: 30,
    state: 'running',
    exitCode: null,
    ...extra,
  }
}

function makeController(options = {}) {
  const maxTerminals = options.maxTerminals ?? 8
  let list = (options.terminals ?? []).map((info) => ({ ...info }))
  const closedIds = new Set()
  const terminals = new Map()
  const calls = { create: [], close: [] }

  function attachPty(info) {
    if (options.osc !== undefined) return attachOscPty(info)
    let screen = 'prompt$ '
    terminals.set(info.id, {
      info,
      serializer: { serialize: () => screen },
      handle: {
        write: async (data) => {
          screen += `${String(data).replace(/\r/g, '')}\nterminal-ready\nprompt$ `
        },
      },
    })
  }

  /**
   * 带 OSC 133 的假终端：维护一份极简的行缓冲与 marker，
   * 写入时按真实 shell 集成的顺序模拟 C → 输出 → D → A/B。
   */
  function attachOscPty(info) {
    const lines = ['prompt$ ']
    let cursorY = 0
    let cursorX = 8
    const handlers = new Map()
    const screen = {
      get buffer() {
        return {
          active: {
            baseY: 0,
            get cursorY() {
              return cursorY
            },
            get cursorX() {
              return cursorX
            },
            type: 'normal',
            getLine(y) {
              return { translateToString: () => lines[y] ?? '' }
            },
          },
        }
      },
      parser: {
        registerOscHandler(ident, fn) {
          handlers.set(ident, fn)
          return {
            dispose() {
              handlers.delete(ident)
            },
          }
        },
      },
      registerMarker(offset = 0) {
        const line = cursorY + offset
        return { line, dispose() {} }
      },
    }
    const pty = {
      info,
      serializer: { serialize: () => lines.join('\n') },
      screen,
      handle: {
        write: async (data) => {
          const command = String(data).replace(/\r/g, '')
          lines[cursorY] = (lines[cursorY] ?? '') + command
          lines.push('')
          cursorY = lines.length - 1
          cursorX = 0
          handlers.get(133)?.('C')
          lines[cursorY] = command.includes('[secret]') ? 'TOKEN=abc123' : 'terminal-ready'
          lines.push('')
          cursorY = lines.length - 1
          cursorX = 0
          if (options.osc === 'defer') return
          const match = /\[rc=(\d+)\]/.exec(command)
          pty.finish(match === null ? 0 : Number(match[1]))
        },
      },
    }
    pty.emitOsc = (ident, data) => handlers.get(ident)?.(data)
    pty.finish = (code = 0) => {
      handlers.get(133)?.(`D;${Number.isFinite(code) ? code : 0}`)
      lines[cursorY] = 'prompt$ '
      cursorX = 8
      handlers.get(133)?.('A')
      handlers.get(133)?.('B')
    }
    terminals.set(info.id, pty)
  }

  for (const info of list) {
    if (info.state === 'running' && options.attachPty !== false) attachPty(info)
  }

  const controller = {
    list(_sessionId) {
      return list.map((info) => ({ ...info }))
    },
    async create(_agent, request) {
      calls.create.push({ ...request })
      if (closedIds.has(request.id)) {
        const error = new Error('Terminal was closed in this Session')
        error.code = 'terminal/unavailable'
        throw error
      }
      const existing = list.find((info) => info.id === request.id)
      if (existing !== undefined) return { ...existing }
      if (list.length >= maxTerminals) {
        const error = new Error('Session terminal limit reached')
        error.code = 'terminal/limit-reached'
        throw error
      }
      const info = terminal(request.id, { cols: request.cols, rows: request.rows })
      list.push(info)
      if (options.attachPty !== false) attachPty(info)
      return { ...info }
    },
    async close(_agent, id) {
      calls.close.push(id)
      closedIds.add(id)
      list = list.filter((info) => info.id !== id)
      terminals.delete(id)
    },
    terminal(_agent, id) {
      return terminals.get(id)
    },
    get listValue() {
      return list
    },
    get closedIds() {
      return closedIds
    },
    get calls() {
      return calls
    },
  }
  return controller
}

/**
 * 无宿主的极简 OSC 终端：只实现块跟踪器用到的 buffer / marker / parser，
 * 让纯函数测试可以逐条驱动 A/B/C/D。
 */
function fakeOscTerminal() {
  const lines = ['prompt$ ']
  let cursorY = 0
  let cursorX = 8
  const handlers = new Map()
  const screen = {
    get buffer() {
      return {
        active: {
          baseY: 0,
          get cursorY() {
            return cursorY
          },
          get cursorX() {
            return cursorX
          },
          type: 'normal',
          getLine(y) {
            return { translateToString: () => lines[y] ?? '' }
          },
        },
      }
    },
    parser: {
      registerOscHandler(ident, fn) {
        handlers.set(ident, fn)
        return {
          dispose() {
            handlers.delete(ident)
          },
        }
      },
    },
    registerMarker(offset = 0) {
      const line = cursorY + offset
      return { line, dispose() {} }
    },
  }
  return {
    screen,
    emit(data) {
      return handlers.get(133)?.(data)
    },
    emitOsc(ident, data) {
      return handlers.get(ident)?.(data)
    },
    writeCommand(command) {
      lines[cursorY] = `${lines[cursorY] ?? ''}${command}`
      lines.push('')
      cursorY = lines.length - 1
      cursorX = 0
      handlers.get(133)?.('C')
    },
    writeOutput(text) {
      for (const line of String(text).split('\n')) {
        lines[cursorY] = line
        lines.push('')
        cursorY = lines.length - 1
        cursorX = 0
      }
    },
    prompt() {
      lines[cursorY] = 'prompt$ '
      cursorX = 8
      handlers.get(133)?.('A')
      handlers.get(133)?.('B')
    },
    finish(code = 0) {
      handlers.get(133)?.(`D;${code}`)
    },
  }
}

function makeHarness(options = {}) {
  const controller = makeController(options)
  let policy = options.policy ?? 'ask'
  const tools = new Map()
  const handlers = {}
  let command

  const ctx = {
    terminalController: controller,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on(event, handler) {
      handlers[event] = handler
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(deps, callback) {
      if (deps.includes('commands')) {
        callback({
          commands: {
            register(definition) {
              command = definition
              return () => {}
            },
          },
        })
      }
    },
    get(name) {
      if (name === 'approval') return { effectivePolicy: () => policy }
      return undefined
    },
  }

  const saved = console.log
  console.log = () => {}
  try {
    mod.apply(ctx)
  } finally {
    console.log = saved
  }

  return {
    controller,
    tools,
    handlers,
    get command() {
      return command
    },
    get policy() {
      return policy
    },
    setPolicy(next) {
      policy = next
    },
    async gate(name, args) {
      return await handlers['tools/pre-execute'](
        { name, agent, arguments: args },
        async () => 'NEXT',
      )
    },
  }
}

/* ------------------------------------------------------------------ */
/* 1. 专属终端重建：exit 后不能卡死                                     */
/* ------------------------------------------------------------------ */

test('没有专属终端时创建一个带时间戳后缀的新 id', async () => {
  const controller = makeController()
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.equal(info.state, 'running')
  assert.ok(info.id.startsWith(`${ownBase}-`), info.id)
  assert.equal(controller.listValue.length, 1)
})

test('已有运行中的专属终端时直接复用，不重复创建', async () => {
  const running = terminal(`${ownBase}-old`)
  const controller = makeController({ terminals: [running] })
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.equal(info.id, running.id)
  assert.equal(controller.calls.create.length, 0)
})

test('旧专属终端 exited 时创建新实例，旧记录默认保留', async () => {
  const exited = terminal(ownBase, { state: 'exited' })
  const controller = makeController({ terminals: [exited] })
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.notEqual(info.id, exited.id)
  assert.ok(info.id.startsWith(`${ownBase}-`), info.id)
  assert.equal(controller.listValue.length, 2)
  assert.ok(controller.listValue.some((item) => item.id === exited.id))
})

test('终端数达上限时关闭旧专属终端释放槽位并重试成功', async () => {
  const exited = terminal(ownBase, { state: 'exited' })
  const controller = makeController({ terminals: [exited], maxTerminals: 1 })
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.equal(info.state, 'running')
  assert.deepEqual(controller.calls.close, [exited.id])
  assert.equal(controller.listValue.length, 1)
  assert.equal(controller.listValue[0].id, info.id)
})

test('上限只差一个槽位时只关一个旧专属终端，保留其余记录', async () => {
  const older = terminal(`${ownBase}-old1`, { state: 'exited' })
  const newer = terminal(`${ownBase}-old2`, { state: 'exited' })
  const controller = makeController({ terminals: [older, newer], maxTerminals: 2 })
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.equal(info.state, 'running')
  assert.deepEqual(controller.calls.close, [older.id])
  assert.ok(controller.listValue.some((item) => item.id === newer.id))
})

test('上限被外部终端占满且无旧专属终端时，报出真实原因', async () => {
  const controller = makeController({
    terminals: [terminal('tab-external')],
    maxTerminals: 1,
  })
  await assert.rejects(mod.ensureOwnTerminal(controller, agent), /终端数已达上限/)
})

test('旧版本固定 id 已被 close 也不会阻塞重建', async () => {
  const controller = makeController()
  controller.closedIds.add(ownBase)
  const info = await mod.ensureOwnTerminal(controller, agent)
  assert.notEqual(info.id, ownBase)
  assert.equal(info.state, 'running')
})

/* ------------------------------------------------------------------ */
/* 3. /terminal-access 命令（只读状态）                                 */
/* ------------------------------------------------------------------ */

function accessHarness(extra = {}) {
  const own = terminal(`${ownBase}-live`)
  const external = terminal('tab-506', { title: '506' })
  const harness = makeHarness({ terminals: [own, external], ...extra })
  return { harness, own, external }
}

test('列表显示助手专属 / 主人终端 / 需审批，并说明权限跟随 DSH', () => {
  const { harness } = accessHarness()
  const result = harness.command.handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /助手专属/)
  assert.match(result.text, /主人终端/)
  assert.match(result.text, /可读 · 写入需审批/)
  assert.match(result.text, /跟随 DSH/)
  assert.doesNotMatch(result.text, /\/terminal-access grant/)
})

test('approval=never 时状态显示可写，说明 full-access 不弹审批', () => {
  const { harness } = accessHarness({ policy: 'never' })
  const result = harness.command.handler({ agent, rawInput: 'status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /可写/)
  assert.match(result.text, /full-access/)
  assert.doesNotMatch(result.text, /\/permission/)
})

test('grant / revoke 子命令已移除，并解释新模型', () => {
  const { harness } = accessHarness()
  for (const verb of ['grant #2 session', 'revoke #2']) {
    const result = harness.command.handler({ agent, rawInput: verb })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /跟随 DSH 权限预设/)
    assert.match(result.text, /不再需要单独/)
  }
})

test('未知子命令返回用法', () => {
  const { harness } = accessHarness()
  const result = harness.command.handler({ agent, rawInput: 'nope' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令/)
})

/* ------------------------------------------------------------------ */
/* 4. 闸门：专属放行 → never 放行 → ask 审批                            */
/* ------------------------------------------------------------------ */

test('指向专属终端直接放行，不弹审批', async () => {
  const { harness } = accessHarness()
  const result = await harness.gate('terminal_run', { terminalId: '#1', command: 'ls' })
  assert.equal(result, 'NEXT')
})

test('指向外部终端且策略为 ask 时返回审批', async () => {
  const { harness } = accessHarness()
  const result = await harness.gate('terminal_run', { terminalId: '#2', command: 'ls' })
  assert.equal(result.kind, 'ask')
  assert.match(result.displayReason.zh, /允许这一次/)
  assert.match(result.displayReason.zh, /当前 DSH 预设需要审批/)
  assert.doesNotMatch(result.displayReason.zh, /\/terminal-access grant/)
})

test('terminal_send 指向外部终端同样请求审批', async () => {
  const { harness } = accessHarness()
  const result = await harness.gate('terminal_send', { terminalId: '#2', text: 'q' })
  assert.equal(result.kind, 'ask')
})

test('approval=never 时直接放行，不弹审批', async () => {
  const { harness } = accessHarness({ policy: 'never' })
  assert.equal(await harness.gate('terminal_run', { terminalId: '#2', command: 'ls' }), 'NEXT')
  assert.equal(await harness.gate('terminal_send', { terminalId: '#2', text: 'q' }), 'NEXT')
})

test('策略读不到时 fail-closed：仍然请求审批', async () => {
  const { harness } = accessHarness()
  harness.setPolicy(undefined)
  const result = await harness.gate('terminal_run', { terminalId: '#2', command: 'ls' })
  assert.equal(result.kind, 'ask')
})

test('省略 terminalId 和未知终端都交给工具自己处理', async () => {
  const { harness } = accessHarness()
  assert.equal(await harness.gate('terminal_run', { command: 'ls' }), 'NEXT')
  assert.equal(await harness.gate('terminal_run', { terminalId: '#9', command: 'ls' }), 'NEXT')
})

test('terminal_read / terminal_list / terminal_blocks 始终不过写入闸门', async () => {
  const { harness } = accessHarness({ policy: 'never' })
  for (const name of ['terminal_read', 'terminal_list', 'terminal_blocks']) {
    assert.equal(await harness.gate(name, { terminalId: '#2' }), 'NEXT', `${name} 不应被写入闸门拦截`)
  }
})

/* ------------------------------------------------------------------ */
/* 5. terminal_list 的结构化 access                                     */
/* ------------------------------------------------------------------ */

test('terminal_list 映射 own / approval / writable', async () => {
  const { harness, own, external } = accessHarness()
  let listed = await harness.tools.get('terminal_list').execute({}, { agent })
  assert.deepEqual(
    listed.access.map((entry) => [entry.id, entry.access]),
    [
      [own.id, 'own'],
      [external.id, 'approval'],
    ],
  )
  assert.equal('grant' in listed.access.find((entry) => entry.id === external.id), false)
  assert.match(listed.terminals, /写入需审批/)
  harness.setPolicy('never')
  listed = await harness.tools.get('terminal_list').execute({}, { agent })
  assert.equal(listed.access.find((entry) => entry.id === external.id).access, 'writable')
  assert.match(listed.terminals, /full-access/)
})

test('专属终端 exited 时标记为 own + read-only + exited，ownTerminalId 为空', async () => {
  const exited = terminal(ownBase, { state: 'exited' })
  const harness = makeHarness({ terminals: [exited] })
  const listed = await harness.tools.get('terminal_list').execute({}, { agent })
  assert.equal(listed.ownTerminalId, '')
  const item = listed.access[0]
  assert.equal(item.own, true)
  assert.equal(item.access, 'read-only')
  assert.equal(item.reason, 'exited')
  assert.match(listed.terminals, /已退出/)
  assert.match(listed.terminals, /自动重建/)
})

/* ------------------------------------------------------------------ */
/* 6. terminal_run 端到端：exited 后自动重建并执行                       */
/* ------------------------------------------------------------------ */

test('专属终端 exited 后，terminal_run 省略 id 会重建并返回输出', async () => {
  const exited = terminal(ownBase, { state: 'exited' })
  const harness = makeHarness({ terminals: [exited] })
  const result = await harness.tools.get('terminal_run').execute(
    { command: 'echo terminal-ready' },
    { agent },
  )
  assert.notEqual(result.terminalId, ownBase)
  assert.match(result.output, /terminal-ready/)
  const created = harness.controller.listValue.find((item) => item.id === result.terminalId)
  assert.equal(created.state, 'running')
  assert.ok(harness.controller.listValue.some((item) => item.id === ownBase))
})

test('显式指向已退出的专属终端时，terminal_run 也会重定向到新实例', async () => {
  const exited = terminal(ownBase, { state: 'exited' })
  const harness = makeHarness({ terminals: [exited] })
  const result = await harness.tools.get('terminal_run').execute(
    { command: 'echo again', terminalId: ownBase },
    { agent },
  )
  assert.notEqual(result.terminalId, ownBase)
  assert.match(result.output, /terminal-ready/)
})

test('显式指向已退出的外部终端时，给出明确错误而不是静默失败', async () => {
  const external = terminal('tab-exited', { title: '506', state: 'exited' })
  const harness = makeHarness({ terminals: [external] })
  await assert.rejects(
    harness.tools.get('terminal_run').execute(
      { command: 'ls', terminalId: '#1' },
      { agent },
    ),
    /不能写入/,
  )
})

/* ------------------------------------------------------------------ */
/* 7. S5：OSC 133 宿主侧命令块 + terminal_blocks                        */
/* ------------------------------------------------------------------ */

test('parseOsc133 识别 A/B/C/D，D 缺省退出码时为 null', () => {
  assert.deepEqual(mod.parseOsc133('A'), { kind: 'A', payload: '' })
  assert.deepEqual(mod.parseOsc133('B'), { kind: 'B', payload: '' })
  assert.deepEqual(mod.parseOsc133('C;ls'), { kind: 'C', payload: 'ls' })
  assert.deepEqual(mod.parseOsc133('D;1'), { kind: 'D', exitCode: 1, payload: '1' })
  assert.equal(mod.parseOsc133('D').exitCode, null)
  assert.equal(mod.parseOsc133('D;abc').exitCode, null)
  assert.equal(mod.parseOsc133('X;1'), null)
  assert.equal(mod.parseOsc133(''), null)
})

test('块跟踪器记录命令、输出、退出码与耗时', () => {
  const term = fakeOscTerminal()
  let clock = 1000
  const tracker = mod.createBlockTracker(term, { now: () => (clock += 10) })
  term.prompt()
  term.writeCommand('echo hi')
  term.writeOutput('hi')
  term.finish(0)
  term.prompt()
  const blocks = tracker.list()
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].command, 'echo hi')
  /* A 标记会回退 endLine，提示符行不能混进输出 */
  assert.equal(blocks[0].output, 'hi')
  assert.equal(blocks[0].exitCode, 0)
  assert.equal(blocks[0].endedAt - blocks[0].startedAt, 10)
  assert.equal(mod.blockStateOf(blocks[0]), 'ok')
})

test('C 未等到 D 又来 C 时，上一条标记为 interrupted', () => {
  const term = fakeOscTerminal()
  const tracker = mod.createBlockTracker(term)
  term.prompt()
  term.writeCommand('sleep 9')
  term.writeOutput('partial')
  term.writeCommand('echo next')
  const all = tracker.all()
  assert.equal(all.length, 2)
  assert.equal(all[0].reason, 'interrupted')
  assert.equal(all[0].exitCode, undefined)
  assert.equal(mod.blockStateOf(all[0]), 'unknown')
  assert.equal(all[1].command, '')
  assert.equal(mod.blockStateOf(all[1]), 'running')
})

test('块跟踪器按 limit 淘汰最旧的块', () => {
  const term = fakeOscTerminal()
  const tracker = mod.createBlockTracker(term, { limit: 2 })
  for (let index = 0; index < 3; index += 1) {
    term.prompt()
    term.writeCommand(`echo ${index}`)
    term.writeOutput(String(index))
    term.finish(0)
  }
  assert.deepEqual(
    tracker.list().map((block) => block.command),
    ['echo 1', 'echo 2'],
  )
})

test('没有 parser 的终端不会建立块跟踪器', () => {
  assert.equal(mod.createBlockTracker({ screen: {} }), undefined)
  assert.equal(mod.blockTrackerOf({ screen: {} }), undefined)
})

test('terminal_run 命中 OSC 块时返回 blockId / exitCode / durationMs', async () => {
  const harness = makeHarness({ osc: true })
  const run = harness.tools.get('terminal_run')
  const first = await run.execute({ command: 'echo hi' }, { agent })
  assert.equal(first.blockId, 1)
  assert.equal(first.exitCode, 0)
  /* 假终端是同步收尾的，但 C 与 D 之间可能跨过 1 毫秒，不能断言恰好为 0。 */
  assert.ok(Number.isFinite(first.durationMs) && first.durationMs >= 0 && first.durationMs < 1000)
  assert.equal(first.output, 'terminal-ready')
  assert.equal(first.timedOut, false)

  const second = await run.execute({ command: 'false [rc=7]' }, { agent })
  assert.equal(second.blockId, 2)
  assert.equal(second.exitCode, 7)
  assert.equal(second.output, 'terminal-ready')

  const tracker = mod.blockTrackerOf(harness.controller.terminal(agent, first.terminalId))
  const block = tracker.find(2)
  assert.equal(block.command, 'false [rc=7]')
  assert.equal(mod.blockStateOf(block), 'fail')

  /* OSC 7 之后的新命令应带上开始目录 */
  harness.controller.terminal(agent, first.terminalId).emitOsc(7, '/tmp/work')
  const third = await run.execute({ command: 'pwd' }, { agent })
  assert.equal(third.cwd, '/tmp/work')
})

test('terminal_run 返回输出前会脱敏', async () => {
  const harness = makeHarness({ osc: true })
  const result = await harness.tools.get('terminal_run').execute(
    { command: 'env [secret]' },
    { agent },
  )
  assert.equal(result.output, 'TOKEN=***')
  assert.doesNotMatch(result.screen, /abc123/)
})

test('parseOsc7 解析裸路径与 file:// URI', () => {
  assert.equal(mod.parseOsc7('/home/ubuntu'), '/home/ubuntu')
  assert.equal(mod.parseOsc7('file://host/home/ubuntu'), '/home/ubuntu')
  assert.equal(mod.parseOsc7('file:///home/ubuntu'), '/home/ubuntu')
  assert.equal(mod.parseOsc7('file://host/a%20b'), '/a b')
  assert.equal(mod.parseOsc7(''), '')
})

test('OSC 7 记录 cwd，命令块带上开始目录', () => {
  const term = fakeOscTerminal()
  const tracker = mod.createBlockTracker(term)
  term.emitOsc(7, '/srv/app')
  term.prompt()
  term.writeCommand('pwd')
  term.writeOutput('/srv/app')
  term.finish(0)
  assert.equal(tracker.cwd, '/srv/app')
  assert.equal(tracker.list()[0].cwd, '/srv/app')
})

test('redactText 覆盖常见凭据形态且不误伤普通变量', () => {
  assert.equal(mod.redactText('PASSWORD=hunter2'), 'PASSWORD=***')
  assert.equal(mod.redactText('{"password":"hunter2","user":"alice"}'), '{"password":***,"user":"alice"}')
  assert.equal(mod.redactText('{"path":"/usr/bin"}'), '{"path":"/usr/bin"}')
  assert.equal(mod.redactText('export API_KEY="sk-live-1234567890abcdef"'), 'export API_KEY=***')
  assert.equal(mod.redactText('mysql --password hunter2 -h db'), 'mysql --password *** -h db')
  assert.equal(mod.redactText('deploy --token=abc123'), 'deploy --token=***')
  assert.equal(
    mod.redactText('https://user:pa55@example.com/x'),
    'https://user:***@example.com/x',
  )
  assert.match(mod.redactText('Authorization: Bearer abcdefgh12345678'), /\*\*\*/)
  assert.doesNotMatch(mod.redactText('Authorization: Bearer abcdefgh12345678'), /abcdefgh/)
  assert.doesNotMatch(
    mod.redactText('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
    /\nabc\n/,
  )
  assert.doesNotMatch(mod.redactText('token: ghp_abcdefghijklmnopqrstuvwxyz012345'), /ghp_/)
  assert.doesNotMatch(mod.redactText('key AKIAIOSFODNN7EXAMPLE'), /AKIAIOSFODNN7EXAMPLE/)
  assert.doesNotMatch(
    mod.redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'),
    /eyJhbGciOiJIUzI1NiJ9/,
  )
  assert.equal(
    mod.redactText("sshpass -p 'hunter2' ssh host"),
    'sshpass -p *** ssh host',
  )
  assert.equal(
    mod.redactText('curl -u alice:s3cret https://example.com'),
    'curl -u alice:*** https://example.com',
  )
  /* 只是包含 token 字样 / 当前目录 / 普通单词，不能误伤 */
  assert.equal(mod.redactText('TOKENIZERS_PARALLELISM=false'), 'TOKENIZERS_PARALLELISM=false')
  assert.equal(mod.redactText('PWD=/home/ubuntu'), 'PWD=/home/ubuntu')
  assert.equal(mod.redactText('bypass=1'), 'bypass=1')
  assert.equal(mod.redactText('path=/usr/local/bin'), 'path=/usr/local/bin')
})

test('OSC 终端里命令超时：timedOut=true，且不伪造退出码', async () => {
  const harness = makeHarness({ terminals: [terminal(ownBase)], osc: 'defer' })
  const result = await harness.tools.get('terminal_run').execute(
    { command: 'sleep 9', timeoutMs: 1000 },
    { agent },
  )
  assert.equal(result.timedOut, true)
  assert.equal(result.blockId, undefined)
  assert.equal(result.exitCode, undefined)
})

test('terminal_blocks 最新优先、支持 limit 与 includeOutput', async () => {
  const harness = makeHarness({ osc: true })
  const run = harness.tools.get('terminal_run')
  const firstRun = await run.execute({ command: 'echo one' }, { agent })
  harness.controller.terminal(agent, firstRun.terminalId).emitOsc(7, '/srv/app')
  await run.execute({ command: 'false [rc=7]' }, { agent })
  const tool = harness.tools.get('terminal_blocks')

  const listed = await tool.execute({}, { agent })
  assert.equal(listed.total, 2)
  assert.deepEqual(
    listed.blocks.map((block) => [block.id, block.state, block.exitCode]),
    [
      [2, 'fail', 7],
      [1, 'ok', 0],
    ],
  )
  assert.equal(listed.blocks[0].cwd, '/srv/app')
  assert.equal(listed.blocks[1].cwd, undefined)
  assert.match(listed.blocks[0].command, /rc=7/)
  assert.match(listed.blocks[0].output, /terminal-ready/)

  const limited = await tool.execute({ limit: 1 }, { agent })
  assert.equal(limited.total, 2)
  assert.deepEqual(limited.blocks.map((block) => block.id), [2])

  const silent = await tool.execute({ includeOutput: false }, { agent })
  assert.deepEqual(silent.blocks.map((block) => block.output), ['', ''])
})

test('terminal_blocks 对执行中的块返回实时输出与 running 状态', async () => {
  const harness = makeHarness({ terminals: [terminal(ownBase)], osc: 'defer' })
  const pty = harness.controller.terminal(agent, ownBase)
  mod.blockTrackerOf(pty)
  await pty.handle.write('sleep 9')
  const tool = harness.tools.get('terminal_blocks')

  const running = await tool.execute({}, { agent })
  assert.equal(running.total, 1)
  assert.equal(running.blocks[0].state, 'running')
  assert.equal(running.blocks[0].exitCode, undefined)
  assert.match(running.blocks[0].output, /terminal-ready/)

  pty.finish(0)
  const done = await tool.execute({}, { agent })
  assert.equal(done.blocks[0].state, 'ok')
  assert.equal(done.blocks[0].exitCode, 0)
})

test('新建终端在 create 时就挂上块跟踪器，无需先调终端工具', async () => {
  const harness = makeHarness({ osc: true })
  /* 模拟浏览器新建终端：直接走 controller.create，不经过任何 terminal_* 工具。 */
  const created = await harness.controller.create(agent, { id: 'external-early', cols: 80, rows: 24 })
  const pty = harness.controller.terminal(agent, created.id)
  assert.notEqual(pty[Symbol.for('dsh-terminal-workbench.block-tracker.v1')], undefined)

  pty.emitOsc(133, 'A')
  pty.emitOsc(133, 'B')
  await pty.handle.write('make test')

  const listed = await harness.tools.get('terminal_blocks').execute({ terminalId: 'external-early' }, { agent })
  assert.equal(listed.total, 1)
  assert.equal(listed.blocks[0].command, 'make test')
  assert.equal(listed.blocks[0].exitCode, 0)
})

test('terminal_list 会给已有终端补跟踪器，之后手动命令进块表', async () => {
  const harness = makeHarness({ terminals: [terminal('external-seed')], osc: true })
  const pty = harness.controller.terminal(agent, 'external-seed')
  const trackerKey = Symbol.for('dsh-terminal-workbench.block-tracker.v1')
  assert.equal(pty[trackerKey], undefined)

  await harness.tools.get('terminal_list').execute({}, { agent })
  assert.notEqual(pty[trackerKey], undefined)

  pty.emitOsc(133, 'A')
  pty.emitOsc(133, 'B')
  await pty.handle.write('ls -la [rc=3]')

  const listed = await harness.tools.get('terminal_blocks').execute({ terminalId: 'external-seed' }, { agent })
  assert.equal(listed.total, 1)
  assert.equal(listed.blocks[0].command, 'ls -la [rc=3]')
  assert.equal(listed.blocks[0].state, 'fail')
  assert.equal(listed.blocks[0].exitCode, 3)
})

test('没有 shell 集成的终端，terminal_blocks 返回空表并提示看屏幕', async () => {
  const harness = makeHarness({ terminals: [terminal('tab-506', { title: '506' })] })
  const tool = harness.tools.get('terminal_blocks')
  const listed = await tool.execute({}, { agent })
  assert.equal(listed.total, 0)
  assert.deepEqual(listed.blocks, [])
  const rendered = tool.output.render({}, listed)
  assert.match(rendered[0].text, /还没有命令块/)
  assert.match(rendered[0].text, /terminal_read/)
})

/* ------------------------------------------------------------------ */

for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`ok   - ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL - ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}
console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
