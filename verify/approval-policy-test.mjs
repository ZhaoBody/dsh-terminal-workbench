#!/usr/bin/env node
/**
 * 审批策略共享模块回归。
 *
 * 覆盖四层：
 *   1. 策略读取：只读 `approval.effectivePolicy`，服务缺席 / 会话缺失 / 抛错都回 undefined；
 *   2. never 判定：只有 `never` 产生确定性拒绝，`ask` 与 `undefined` 不拦；
 *   3. 结果形状：ask 的 `reason` 与中英文文案、deny 不带 displayReason；
 *   4. 静态接线：三个工具模块共用本模块，且 never 判定先于授权消费。
 *
 * 运行：node verify/approval-policy-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

import {
  approvalPolicyOf,
  denyForNever,
  askForApproval,
  askOrDeny,
} from '../lib/approval-policy.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

/* ------------------------------------------------------------------ */
/* 1. 策略读取                                                         */
/* ------------------------------------------------------------------ */

test('approvalPolicyOf：按 agent.session 读取 effectivePolicy', () => {
  const seen = []
  const ctx = {
    get(name) {
      assert.equal(name, 'approval')
      return {
        effectivePolicy(session) {
          seen.push(session)
          return 'ask'
        },
      }
    },
  }
  const agent = { session: { id: 's1' } }
  assert.equal(approvalPolicyOf(ctx, agent), 'ask')
  assert.deepEqual(seen, [agent.session])
})

test('approvalPolicyOf：审批服务缺席时返回 undefined', () => {
  assert.equal(approvalPolicyOf({ get: () => undefined }, { session: { id: 's1' } }), undefined)
  assert.equal(approvalPolicyOf({ get: () => undefined }, undefined), undefined)
})

test('approvalPolicyOf：会话缺失时不调用 effectivePolicy', () => {
  let called = false
  const ctx = {
    get: () => ({
      effectivePolicy() {
        called = true
        return 'never'
      },
    }),
  }
  assert.equal(approvalPolicyOf(ctx, {}), undefined)
  assert.equal(called, false)
})

test('approvalPolicyOf：读取抛错时返回 undefined，而不是冒泡', () => {
  const ctx = {
    get() {
      throw new Error('service unavailable')
    },
  }
  assert.equal(approvalPolicyOf(ctx, { session: { id: 's1' } }), undefined)
})

/* ------------------------------------------------------------------ */
/* 2. never 判定                                                       */
/* ------------------------------------------------------------------ */

test('denyForNever：never 生成确定性拒绝，并保留 reason', () => {
  const result = denyForNever('never', 'policy denied')
  assert.deepEqual(result, { kind: 'deny', reason: 'policy denied' })
})

test('denyForNever：ask 与 undefined 都不拦', () => {
  assert.equal(denyForNever('ask', 'x'), undefined)
  assert.equal(denyForNever(undefined, 'x'), undefined)
})

/* ------------------------------------------------------------------ */
/* 3. 结果形状                                                         */
/* ------------------------------------------------------------------ */

test('askForApproval：统一 ask 形状并原样保留双语文案', () => {
  const displayReason = { en: 'Allow?', zh: '允许吗？' }
  assert.deepEqual(askForApproval('r1', displayReason), {
    kind: 'ask',
    reason: 'r1',
    displayReason,
  })
})

test('askOrDeny：never 走 deny，且不带 displayReason', () => {
  const result = askOrDeny({
    policy: 'never',
    neverReason: 'blocked by never',
    reason: 'would ask',
    displayReason: { en: 'Allow?', zh: '允许吗？' },
  })
  assert.deepEqual(result, { kind: 'deny', reason: 'blocked by never' })
})

test('askOrDeny：ask / undefined 都走 ask', () => {
  const options = {
    neverReason: 'blocked by never',
    reason: 'would ask',
    displayReason: { en: 'Allow?', zh: '允许吗？' },
  }
  for (const policy of ['ask', undefined]) {
    assert.deepEqual(askOrDeny({ ...options, policy }), {
      kind: 'ask',
      reason: 'would ask',
      displayReason: options.displayReason,
    })
  }
})

/* ------------------------------------------------------------------ */
/* 4. 三个工具模块的静态接线                                           */
/* ------------------------------------------------------------------ */

test('forward-tools：只从共享模块取策略，不再保留本地实现', () => {
  const source = read('lib/forward-tools.js')
  assert.match(source, /import \{ approvalPolicyOf, askOrDeny \} from '\.\/approval-policy\.js'/)
  assert.equal(source.includes('function approvalPolicyOf'), false)
  assert.match(source, /askOrDeny\(\{/)
  assert.match(source, /neverReason:/)
})

test('remote-fs-tools：只从共享模块取策略，不再保留本地实现', () => {
  const source = read('lib/remote-fs-tools.js')
  assert.match(source, /import \{ approvalPolicyOf, askOrDeny \} from '\.\/approval-policy\.js'/)
  assert.equal(source.includes('function approvalPolicyOf'), false)
  assert.match(source, /askOrDeny\(\{/)
  assert.match(source, /neverReason:/)
})

test('agent-terminal：使用共享 approvalPolicyOf / askForApproval', () => {
  const source = read('lib/agent-terminal.js')
  assert.match(source, /import \{ approvalPolicyOf, askForApproval \} from '\.\/approval-policy\.js'/)
  assert.equal(source.includes('function approvalPolicyOf'), false)
  assert.equal(source.includes('createGrantStore'), false)
  assert.equal(source.includes('grants.consume('), false)
  assert.match(source, /return askForApproval\(/)
})

test('agent-terminal：never 直接放行，ask 才请求审批', () => {
  const source = read('lib/agent-terminal.js')
  const never = source.indexOf("if (policy === 'never') return next()")
  const ask = source.indexOf('return askForApproval(')
  assert.ok(never >= 0, 'never 分支应直接放行')
  assert.ok(ask >= 0, 'ask 分支应请求审批')
  assert.ok(never < ask, 'never 判定应排在 ask 之前')
})

test('agent-terminal：所有 approvalPolicyOf 调用都带 ctx', () => {
  const source = read('lib/agent-terminal.js')
  const calls = [...source.matchAll(/approvalPolicyOf\(([^)]*)\)/g)].map((match) => match[1])
  assert.ok(calls.length >= 4, '应有多个策略读取点')
  for (const args of calls) {
    assert.match(args, /^ctx,\s*(agent|exec\.agent)$/, `调用参数应包含 ctx：approvalPolicyOf(${args})`)
  }
})

test('forward / remote-fs 的 never 文案指向 /permission；终端跟随 DSH 不再单独提示', () => {
  for (const relative of ['lib/forward-tools.js', 'lib/remote-fs-tools.js']) {
    const source = read(relative)
    assert.match(source, /never/, `${relative} 应提到 never`)
    assert.match(source, /\/permission/, `${relative} 的 never 文案应指引 /permission`)
  }
  const terminal = read('lib/agent-terminal.js')
  assert.match(terminal, /never/)
  assert.doesNotMatch(terminal, /\/permission/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
