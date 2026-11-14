#!/usr/bin/env node
/**
 * SSH 隧道纯函数回归（不需要真实 SSH）。
 *
 * 覆盖：转发规格解析、跳板链解析、管理器边界（上限/未知 id/卸载幂等）。
 * 真实链路（forwardOut / SOCKS5 穿透 / 端口释放）需要 sshd，另见 forward-e2e 待补。
 *
 * 运行：node verify/forward-parse-test.mjs
 */
import assert from 'node:assert'
import { MAX_FORWARDS, MAX_CHAIN, ForwardManager, parseForward, resolveChain } from '../lib/forward.js'

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

function codeOf(fn) {
  try {
    fn()
  } catch (error) {
    return error?.code
  }
  return 'NO_THROW'
}

console.log('\nparseForward')

check('L 端口:主机:端口', () => {
  const f = parseForward('L 8080:db.internal:5432')
  assert.equal(f.type, 'L')
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 8080)
  assert.equal(f.destHost, 'db.internal')
  assert.equal(f.destPort, 5432)
})

check('-L 完整监听地址', () => {
  const f = parseForward('-L 127.0.0.1:15432:db.internal:5432')
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 15432)
  assert.equal(f.destHost, 'db.internal')
  assert.equal(f.destPort, 5432)
})

check('R 对象写法', () => {
  const f = parseForward({ type: 'R', bind: '127.0.0.1:8080', dest: 'localhost:3000' })
  assert.equal(f.type, 'R')
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 8080)
  assert.equal(f.destHost, 'localhost')
  assert.equal(f.destPort, 3000)
})

check('D 裸端口', () => {
  const f = parseForward('D 1080')
  assert.equal(f.type, 'D')
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 1080)
  assert.equal(f.destHost, undefined)
})

check('D 指定监听地址', () => {
  const f = parseForward('D 127.0.0.1:1080')
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 1080)
})

check('对象 D 带 bind 端口 0', () => {
  const f = parseForward({ type: 'D', bind: '127.0.0.1:0' })
  assert.equal(f.bindPort, 0)
})

check('bind 省略 → 127.0.0.1:0', () => {
  const f = parseForward({ type: 'L', dest: 'db:5432' })
  assert.equal(f.bindHost, '127.0.0.1')
  assert.equal(f.bindPort, 0)
})

check('bind * → 0.0.0.0', () => {
  const f = parseForward({ type: 'L', bind: '*:8080', dest: 'db:5432' })
  assert.equal(f.bindHost, '0.0.0.0')
})

check('括号 IPv6 目标', () => {
  const f = parseForward({ type: 'L', bind: '8080', dest: '[::1]:22' })
  assert.equal(f.destHost, '::1')
  assert.equal(f.destPort, 22)
})

check('未加括号的 IPv6 明确拒绝', () => {
  assert.equal(codeOf(() => parseForward({ type: 'L', dest: '::1:22' })), 'FORWARD_INVALID')
})

check('非法类型', () => {
  assert.equal(codeOf(() => parseForward('X 8080:db:5432')), 'FORWARD_INVALID')
})

check('端口越界', () => {
  assert.equal(codeOf(() => parseForward('L 70000:db:5432')), 'FORWARD_INVALID')
})

check('端口非数字', () => {
  assert.equal(codeOf(() => parseForward('L abc:db:5432')), 'FORWARD_INVALID')
})

check('空规格', () => {
  assert.equal(codeOf(() => parseForward('')), 'FORWARD_INVALID')
})

check('L 缺少目标端口', () => {
  assert.equal(codeOf(() => parseForward('L 8080:db')), 'FORWARD_INVALID')
})

check('L 参数过多', () => {
  assert.equal(codeOf(() => parseForward('L 8080 db:5432 extra')), 'FORWARD_INVALID')
})

check('D 不允许带目标', () => {
  assert.equal(codeOf(() => parseForward('D 1080:db:5432')), 'FORWARD_INVALID')
})

console.log('\nresolveChain')

const remotes = {
  a: { host: '10.0.0.3', username: 'u' },
  b: { host: '10.0.0.2', username: 'u', jumpHost: 'c' },
  c: { host: '10.0.0.1', username: 'u' },
  d: { host: '10.0.0.4', username: 'u', jumpHost: 'b' },
  self: { host: '10.0.0.5', username: 'u', jumpHost: 'self' },
  jump: { host: '10.0.0.6', username: 'u', jump: 'c' },
  proxy: { host: '10.0.0.7', username: 'u', proxyJump: 'c' },
  broken: { host: '10.0.0.8', username: 'u', jumpHost: 'nope' },
}

check('无跳板 → 单跳', () => {
  assert.deepEqual(resolveChain(remotes, 'a'), ['a'])
})

check('两级跳板 → 最外层在前', () => {
  assert.deepEqual(resolveChain(remotes, 'b'), ['c', 'b'])
})

check('三级跳板', () => {
  assert.deepEqual(resolveChain(remotes, 'd'), ['c', 'b', 'd'])
})

check('jump 字段别名', () => {
  assert.deepEqual(resolveChain(remotes, 'jump'), ['c', 'jump'])
})

check('proxyJump 字段别名', () => {
  assert.deepEqual(resolveChain(remotes, 'proxy'), ['c', 'proxy'])
})

check('自引用循环', () => {
  assert.equal(codeOf(() => resolveChain(remotes, 'self')), 'FORWARD_CYCLE')
})

check('未知远端给出已配置清单', () => {
  try {
    resolveChain(remotes, 'ghost')
  } catch (error) {
    assert.equal(error.code, 'FORWARD_NOT_FOUND')
    assert.ok(error.message.includes('a'))
    return
  }
  assert.fail('应当抛错')
})

check('跳板引用不存在', () => {
  assert.equal(codeOf(() => resolveChain(remotes, 'broken')), 'FORWARD_NOT_FOUND')
})

check(`超过 ${MAX_CHAIN} 跳`, () => {
  const deep = {
    h1: { host: 'h1', username: 'u', jumpHost: 'h2' },
    h2: { host: 'h2', username: 'u', jumpHost: 'h3' },
    h3: { host: 'h3', username: 'u', jumpHost: 'h4' },
    h4: { host: 'h4', username: 'u', jumpHost: 'h5' },
    h5: { host: 'h5', username: 'u' },
  }
  assert.equal(codeOf(() => resolveChain(deep, 'h1')), 'FORWARD_CHAIN_TOO_LONG')
})

console.log('\nForwardManager 边界')

await checkAsync('初始为空', async () => {
  const manager = new ForwardManager('/nonexistent/remotes.json')
  try {
    assert.deepEqual(manager.list(), [])
  } finally {
    manager.dispose()
  }
})

await checkAsync('空 alias 立即拒绝', async () => {
  const manager = new ForwardManager('/nonexistent/remotes.json')
  try {
    await assert.rejects(() => manager.open({ alias: '', type: 'L', dest: 'db:1' }), /alias 不能为空/)
  } finally {
    manager.dispose()
  }
})

await checkAsync('未知 id 关闭报 FORWARD_NOT_FOUND', async () => {
  const manager = new ForwardManager('/nonexistent/remotes.json')
  try {
    await assert.rejects(() => manager.close('fwd-404'), (error) => error.code === 'FORWARD_NOT_FOUND')
  } finally {
    manager.dispose()
  }
})

await checkAsync(`超过 ${MAX_FORWARDS} 条被拒绝`, async () => {
  const manager = new ForwardManager('/nonexistent/remotes.json')
  try {
    for (let i = 0; i < MAX_FORWARDS; i += 1) manager.records.set(`x-${i}`, { closed: true })
    await assert.rejects(
      () => manager.open({ alias: 'a', type: 'L', dest: 'db:1' }),
      (error) => error.code === 'FORWARD_LIMIT',
    )
  } finally {
    manager.dispose()
  }
})

await checkAsync('dispose 幂等', async () => {
  const manager = new ForwardManager('/nonexistent/remotes.json')
  manager.dispose()
  manager.dispose()
  await assert.rejects(() => manager.open({ alias: 'a', type: 'L', dest: 'db:1' }), (error) => error.code === 'FORWARD_DISPOSED')
})

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[FAIL] ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
