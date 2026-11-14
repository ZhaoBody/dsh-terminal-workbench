#!/usr/bin/env node
/**
 * 看门狗宽限期回归：慢启动不能把“还在加载”误判成“加载失败”。
 *
 * 2026-11-08 08:17 事故：浏览器 08:17:04 才开始加载（冷启动 10MB 级客户端包），
 * 旧的固定宽限 `CLIENT_GRACE_MS = 20000` 在 08:17:24 就把仍在加载的页面判死，
 * 改写了补丁层。v0.9.3 起改为“加载静默期 + 在途请求”判定。
 *
 * 运行：node verify/watchdog-grace-test.mjs
 */
import assert from 'node:assert'
import { shouldRescue } from '../lib/index.js'

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

const BOOT = 1_000_000
const BOOT_GRACE = 120_000
const IDLE = 60_000

/** 已经正常加载过的基线状态。 */
function state(overrides = {}) {
  return {
    loadedByClient: false,
    browserRequestWatch: true,
    sawBrowserRequest: true,
    bootedAt: BOOT,
    lastActivityAt: BOOT + BOOT_GRACE,
    inFlight: 0,
    bootGraceMs: BOOT_GRACE,
    clientIdleMs: IDLE,
    ...overrides,
  }
}

check('没人打开页面：不救', () => {
  assert.strictEqual(
    shouldRescue(state({ sawBrowserRequest: false, lastActivityAt: 0, now: BOOT + 600_000 })),
    false,
  )
})

check('请求监听没挂上：不救', () => {
  assert.strictEqual(
    shouldRescue(state({ browserRequestWatch: false, now: BOOT + 600_000 })),
    false,
  )
})

check('客户端已经报到：不救', () => {
  assert.strictEqual(
    shouldRescue(state({ loadedByClient: true, now: BOOT + 600_000 })),
    false,
  )
})

check('宿主启动还没到最低宽限：不救', () => {
  assert.strictEqual(
    shouldRescue(state({ now: BOOT + BOOT_GRACE - 1, lastActivityAt: BOOT })),
    false,
  )
})

check('最后一次加载活动在静默期内：不救', () => {
  assert.strictEqual(
    shouldRescue(state({ now: BOOT + BOOT_GRACE + IDLE - 1 })),
    false,
  )
})

check('加载活动静默满 60 秒且仍未报到：救', () => {
  assert.strictEqual(
    shouldRescue(state({ now: BOOT + BOOT_GRACE + IDLE })),
    true,
  )
})

check('还有客户端资源在途：即使静默很久也不救', () => {
  assert.strictEqual(
    shouldRescue(state({ inFlight: 1, now: BOOT + 600_000 })),
    false,
  )
})

check('慢启动：请求断续来了 5 分钟，每个时刻都不算失败', () => {
  /* 模拟每 30 秒一个请求：开始 → 2 秒后结束 → 再 28 秒后下一个。 */
  for (let step = 0; step < 10; step += 1) {
    const startedAt = BOOT + BOOT_GRACE + step * 30_000
    assert.strictEqual(
      shouldRescue(state({ lastActivityAt: startedAt, inFlight: 1, now: startedAt + 25_000 })),
      false,
      `第 ${step + 1} 个请求在途时误判`,
    )
    assert.strictEqual(
      shouldRescue(state({ lastActivityAt: startedAt + 2_000, inFlight: 0, now: startedAt + 29_000 })),
      false,
      `第 ${step + 1} 个请求结束后静默不足 60 秒时误判`,
    )
  }
})

check('慢启动结束、静默满 60 秒后仍未报到：救', () => {
  const lastFinishedAt = BOOT + BOOT_GRACE + 10 * 30_000
  assert.strictEqual(
    shouldRescue(state({ lastActivityAt: lastFinishedAt, inFlight: 0, now: lastFinishedAt + IDLE })),
    true,
  )
})

check('没有活动时间戳：不救（防御性）', () => {
  assert.strictEqual(
    shouldRescue(state({ lastActivityAt: 0, now: BOOT + 600_000 })),
    false,
  )
})

check('空状态不抛错：不救', () => {
  assert.strictEqual(shouldRescue(), false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
