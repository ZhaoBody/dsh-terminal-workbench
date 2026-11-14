#!/usr/bin/env node
/**
 * 看门狗在途请求回归：挂死的请求不能永久阻塞自救。
 *
 * 2026-11-08 之后的加固点：`inFlight > 0` 是慢启动的保护伞，但如果一个请求
 * 永远不触发 finish/close（客户端断开、TCP 半开、代理卡住），看门狗会一直
 * 等下去。v0.9.4 给单个请求加了最长寿命，超过后不再算“在途”。
 *
 * 运行：node verify/watchdog-inflight-test.mjs
 */
import assert from 'node:assert'
import { countActiveRequests, shouldRescue } from '../lib/index.js'

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

const MAX_AGE = 300_000

check('空表：0 个在途', () => {
  assert.strictEqual(countActiveRequests(new Map(), 1_000_000, MAX_AGE), 0)
})

check('全部新鲜：全部计入', () => {
  const requests = new Map([
    ['a', 990_000],
    ['b', 995_000],
  ])
  assert.strictEqual(countActiveRequests(requests, 1_000_000, MAX_AGE), 2)
})

check('混合新鲜与挂死：只计新鲜的', () => {
  const requests = new Map([
    ['fresh-1', 999_000],
    ['fresh-2', 950_000],
    ['stale-1', 1_000_000 - MAX_AGE - 1],
    ['stale-2', 1_000_000 - MAX_AGE * 2],
  ])
  assert.strictEqual(countActiveRequests(requests, 1_000_000, MAX_AGE), 2)
})

check('刚好到寿命边界：不再计入（>= 即挂死）', () => {
  const requests = new Map([['edge', 1_000_000 - MAX_AGE]])
  assert.strictEqual(countActiveRequests(requests, 1_000_000, MAX_AGE), 0)
})

check('非 Map 输入：防御性返回 0', () => {
  assert.strictEqual(countActiveRequests(undefined, 1_000_000, MAX_AGE), 0)
  assert.strictEqual(countActiveRequests({}, 1_000_000, MAX_AGE), 0)
})

check('挂死请求被剔除后，静默期满足即可自救', () => {
  /* 模拟：最后一次活动是 10 分钟前，唯一的请求也挂了 10 分钟。 */
  const now = 1_000_000
  const lastActivityAt = now - 600_000
  const requests = new Map([['stuck', lastActivityAt]])
  const active = countActiveRequests(requests, now, MAX_AGE)
  assert.strictEqual(active, 0)
  assert.strictEqual(
    shouldRescue({
      loadedByClient: false,
      browserRequestWatch: true,
      sawBrowserRequest: true,
      now,
      bootedAt: now - 900_000,
      lastActivityAt,
      inFlight: active,
      bootGraceMs: 120_000,
      clientIdleMs: 60_000,
    }),
    true,
  )
})

check('新鲜请求仍在途时，即使静默很久也不自救', () => {
  const now = 1_000_000
  const requests = new Map([['fresh', now - 1_000]])
  const active = countActiveRequests(requests, now, MAX_AGE)
  assert.strictEqual(active, 1)
  assert.strictEqual(
    shouldRescue({
      loadedByClient: false,
      browserRequestWatch: true,
      sawBrowserRequest: true,
      now,
      bootedAt: now - 900_000,
      lastActivityAt: now - 600_000,
      inFlight: active,
      bootGraceMs: 120_000,
      clientIdleMs: 60_000,
    }),
    false,
  )
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
