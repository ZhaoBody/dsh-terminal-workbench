#!/usr/bin/env node
/**
 * 终端访问 API 回归：只读快照，不提供授予/撤销。
 *
 * 运行：node verify/terminal-access-api-test.mjs
 */
import { Readable } from 'node:stream'
import assert from 'node:assert'

import { registerTerminalAccessApi } from '../lib/terminal-access-api.js'
import { terminalAccessItems } from '../lib/agent-terminal.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

function terminal(id, extra = {}) {
  return {
    id,
    title: id,
    state: 'running',
    ...extra,
  }
}

function harness(list = [], policy = 'ask') {
  let handler
  const webCtx = {
    effect(fn) {
      fn()
    },
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      },
    },
  }
  registerTerminalAccessApi(webCtx, {
    controller: { list: () => list },
    policyOf: () => policy,
    itemsOf: (sessionId, current, currentPolicy) =>
      terminalAccessItems(sessionId, current, currentPolicy),
  })
  assert.ok(handler, '应注册终端访问路由')
  return { list, request: handler }
}

function req(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  return stream
}

function res() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(body) {
      out.body = String(body ?? '')
    },
    json() {
      return JSON.parse(out.body)
    },
  }
}

async function call(handler, method, url, body) {
  const response = res()
  await handler(req(method, url, body), response)
  return response
}

const URL = '/__dsh-terminal-workbench/terminal-access'

/* ------------------------------------------------------------------ */
/* 1. GET 快照                                                         */
/* ------------------------------------------------------------------ */

await test('GET 在 ask 下返回 own / approval', async () => {
  const h = harness([
    terminal('agent-s1-x'),
    terminal('tab-2'),
    terminal('tab-3'),
  ])
  const response = await call(h.request, 'GET', `${URL}?sessionId=s1`)
  assert.equal(response.out.status, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.equal(body.policy, 'ask')
  assert.deepEqual(
    body.terminals.map((item) => [item.id, item.access, item.own]),
    [
      ['agent-s1-x', 'own', true],
      ['tab-2', 'approval', false],
      ['tab-3', 'approval', false],
    ],
  )
  assert.equal('grant' in body.terminals[1], false)
  assert.match(body.terminals[1].label, /写入需审批/)
})

await test('GET 在 never（full-access）下返回 writable', async () => {
  const h = harness([terminal('agent-s1-x'), terminal('tab-2')], 'never')
  const response = await call(h.request, 'GET', `${URL}?sessionId=s1`)
  const body = response.json()
  assert.equal(body.policy, 'never')
  assert.deepEqual(
    body.terminals.map((item) => [item.id, item.access]),
    [
      ['agent-s1-x', 'own'],
      ['tab-2', 'writable'],
    ],
  )
  assert.equal(body.terminals[1].label, '可写')
})

await test('GET 把已退出终端标为 read-only + exited', async () => {
  const h = harness([terminal('tab-1', { state: 'exited' })])
  const response = await call(h.request, 'GET', `${URL}?sessionId=s1`)
  const item = response.json().terminals[0]
  assert.equal(item.access, 'read-only')
  assert.equal(item.reason, 'exited')
  assert.equal(item.label, '已退出 · 仅可读')
})

await test('GET 缺少 sessionId 返回 400', async () => {
  const h = harness([])
  const response = await call(h.request, 'GET', URL)
  assert.equal(response.out.status, 400)
  assert.equal(response.json().ok, false)
})

await test('旧客户端的 client / generation 参数被忽略，不再触发授权重置', async () => {
  const h = harness([terminal('tab-1')])
  const first = await call(h.request, 'GET', `${URL}?sessionId=s1&client=c1&generation=1`)
  const second = await call(h.request, 'GET', `${URL}?sessionId=s1&client=c1&generation=2`)
  assert.equal(first.out.status, 200)
  assert.equal(second.out.status, 200)
  assert.equal(second.json().generationReset, undefined)
  assert.equal(second.json().terminals[0].access, 'approval')
})

/* ------------------------------------------------------------------ */
/* 2. 写操作一律 405                                                    */
/* ------------------------------------------------------------------ */

await test('POST 返回 405，并说明只提供只读快照', async () => {
  const h = harness([terminal('tab-1')])
  const response = await call(h.request, 'POST', URL, { sessionId: 's1', terminalId: 'tab-1' })
  assert.equal(response.out.status, 405)
  assert.match(response.json().error, /只支持 GET/)
})

await test('DELETE 返回 405', async () => {
  const h = harness([])
  const response = await call(h.request, 'DELETE', `${URL}?sessionId=s1`)
  assert.equal(response.out.status, 405)
})

/* ------------------------------------------------------------------ */
/* 3. 共享快照字段                                                     */
/* ------------------------------------------------------------------ */

await test('terminalAccessItems 带 state / controlled / 中文 label', () => {
  const items = terminalAccessItems(
    's1',
    [terminal('tab-1', { state: 'exited', controllerId: 'client-1' })],
    'ask',
  )
  assert.equal(items[0].state, 'exited')
  assert.equal(items[0].controlled, true)
  assert.equal(items[0].label, '已退出 · 仅可读')
})

await test('terminalAccessItems 不再输出 grant 字段', () => {
  const items = terminalAccessItems('s1', [terminal('tab-1')], 'never')
  assert.equal(items[0].access, 'writable')
  assert.equal('grant' in items[0], false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
