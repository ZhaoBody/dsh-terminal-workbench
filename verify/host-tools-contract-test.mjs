#!/usr/bin/env node
/**
 * 宿主侧工具契约回归（不需要真实 SSH）。
 *
 * 校验 remote-fs-tools / forward-tools 的：
 *   - 工具注册与参数路由
 *   - `remote:别名:/路径` 解析与未知别名报错
 *   - 删除 / 开隧道审批闸门（ask 与 never 两条分支）
 *
 * 运行：node verify/host-tools-contract-test.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply as applyRemoteFsTools } from '../lib/remote-fs-tools.js'
import { apply as applyForwardTools } from '../lib/forward-tools.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

/** 最小 ctx 桩：effect 立即执行工厂，on 记录 hook，tools.register 收集工具。 */
function makeCtx(policy = 'ask') {
  const tools = new Map()
  const hooks = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(factory) {
      disposers.push(factory())
    },
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    get(name) {
      if (name !== 'approval') return undefined
      return { effectivePolicy: () => policy }
    },
  }
  return { ctx, tools, hooks, dispose: () => disposers.forEach((fn) => typeof fn === 'function' && fn()) }
}

function codeOf(error) {
  return error?.code ?? 'NO_CODE'
}

/* ---------- remote-fs-tools ---------- */

function makeRemoteFs() {
  const calls = []
  const backend = {
    async mkdir(p, opts) {
      calls.push(['mkdir', p, opts])
      return { path: p, created: true }
    },
    async rename(from, to) {
      calls.push(['rename', from, to])
      return { from, to, replaced: false }
    },
    async copy(from, to) {
      calls.push(['copy', from, to])
      return { from, to, type: 'file' }
    },
    async remove(p, opts) {
      calls.push(['remove', p, opts])
      return { path: p, type: 'file' }
    },
  }
  return {
    calls,
    aliases: () => ['boxa', 'boxb'],
    backendOf(alias) {
      calls.push(['backendOf', alias])
      return backend
    },
    async copyBetween(from, to) {
      calls.push(['copyBetween', from, to])
      return { from, to, type: 'file', fromAlias: 'boxa', toAlias: 'boxb' }
    },
  }
}

const remotesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twb-tools-')), 'remotes.json')
fs.writeFileSync(
  remotesFile,
  JSON.stringify({
    boxa: { host: '10.0.0.1', username: 'u', auth: 'key' },
    boxb: { host: '10.0.0.2', username: 'u', auth: 'key', jumpHost: 'boxa' },
  }),
)

console.log('\nremote-fs-tools')

await check('注册 5 个工具', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '连接正常', remoteFs: fake })
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['remote_fs_copy', 'remote_fs_list', 'remote_fs_mkdir', 'remote_fs_move', 'remote_fs_remove'],
  )
})

await check('remote_fs_list 显示跳板', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '连接正常', remoteFs: fake })
  const result = await tools.get('remote_fs_list').execute({})
  assert.equal(result.count, 2)
  assert.ok(result.remotes.includes('经跳板 boxa'))
})

await check('mkdir 拒绝非 remote: 写法', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await assert.rejects(() => tools.get('remote_fs_mkdir').execute({ path: '/tmp/x' }), /remote:别名/)
  assert.equal(fake.calls.length, 0)
})

await check('mkdir 拒绝未知别名并列出已配置', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await assert.rejects(() => tools.get('remote_fs_mkdir').execute({ path: 'remote:ghost:/x' }), /boxa、boxb/)
})

await check('mkdir 透传 recursive', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await tools.get('remote_fs_mkdir').execute({ path: 'remote:boxa:/srv/a', recursive: true })
  const call = fake.calls.find((item) => item[0] === 'mkdir')
  assert.deepEqual(call, ['mkdir', '/srv/a', { recursive: true }])
})

await check('move 同机走 rename', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await tools.get('remote_fs_move').execute({ from: 'remote:boxa:/a', to: 'remote:boxa:/b' })
  assert.deepEqual(fake.calls.find((item) => item[0] === 'rename'), ['rename', '/a', '/b'])
})

await check('move 跨机明确拒绝且不调用 rename', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await assert.rejects(
    () => tools.get('remote_fs_move').execute({ from: 'remote:boxa:/a', to: 'remote:boxb:/b' }),
    /跨机/,
  )
  assert.equal(fake.calls.some((item) => item[0] === 'rename'), false)
})

await check('copy 同机走 backend.copy', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await tools.get('remote_fs_copy').execute({ from: 'remote:boxa:/a', to: 'remote:boxa:/b' })
  assert.deepEqual(fake.calls.find((item) => item[0] === 'copy'), ['copy', '/a', '/b'])
  assert.equal(fake.calls.some((item) => item[0] === 'copyBetween'), false)
})

await check('copy 跨机走 copyBetween', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await tools.get('remote_fs_copy').execute({ from: 'remote:boxa:/a', to: 'remote:boxb:/b' })
  assert.deepEqual(
    fake.calls.find((item) => item[0] === 'copyBetween'),
    ['copyBetween', 'remote:boxa:/a', 'remote:boxb:/b'],
  )
})

await check('remove 透传 recursive', async () => {
  const fake = makeRemoteFs()
  const { ctx, tools } = makeCtx()
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  await tools.get('remote_fs_remove').execute({ path: 'remote:boxa:/srv/old', recursive: true })
  assert.deepEqual(fake.calls.find((item) => item[0] === 'remove'), ['remove', '/srv/old', { recursive: true }])
})

console.log('\nremote_fs_remove 审批')

await check('policy=ask → ask', async () => {
  const fake = makeRemoteFs()
  const { ctx, hooks } = makeCtx('ask')
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  let nextCalled = false
  const result = await hooks.get('tools/pre-execute')(
    { name: 'remote_fs_remove', arguments: { path: 'remote:boxa:/x', recursive: true }, agent: { session: {} } },
    async () => {
      nextCalled = true
      return 'next'
    },
  )
  assert.equal(result.kind, 'ask')
  assert.ok(result.displayReason.zh.includes('永久删除'))
  assert.equal(nextCalled, false)
})

await check('policy=never → deny 且给出切换办法', async () => {
  const fake = makeRemoteFs()
  const { ctx, hooks } = makeCtx('never')
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  const result = await hooks.get('tools/pre-execute')(
    { name: 'remote_fs_remove', arguments: { path: 'remote:boxa:/x' }, agent: { session: {} } },
    async () => 'next',
  )
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('/permission'))
})

await check('非审批工具直接放行', async () => {
  const fake = makeRemoteFs()
  const { ctx, hooks } = makeCtx('never')
  applyRemoteFsTools(ctx, { remotesFile, probe: async () => '', remoteFs: fake })
  let nextCalled = false
  await hooks.get('tools/pre-execute')(
    { name: 'remote_fs_mkdir', arguments: {}, agent: { session: {} } },
    async () => {
      nextCalled = true
    },
  )
  assert.equal(nextCalled, true)
})

/* ---------- forward-tools ---------- */

function makeManager() {
  const calls = []
  return {
    calls,
    list() {
      return [
        {
          id: 'fwd-1',
          type: 'L',
          bind: '127.0.0.1:8080',
          dest: 'db:5432',
          chain: 'bastion → target',
        },
      ]
    },
    async open(args) {
      calls.push(['open', args])
      return {
        id: 'fwd-2',
        type: 'L',
        bind: '127.0.0.1:8080',
        dest: 'db:5432',
        chain: 'bastion → target',
      }
    },
    async close(id) {
      calls.push(['close', id])
      return { id, closed: true }
    },
  }
}

console.log('\nforward-tools')

await check('注册 3 个工具', async () => {
  const manager = makeManager()
  const { ctx, tools } = makeCtx()
  applyForwardTools(ctx, { manager })
  assert.deepEqual([...tools.keys()].sort(), ['forward_close', 'forward_list', 'forward_open'])
})

await check('forward_open 透传参数', async () => {
  const manager = makeManager()
  const { ctx, tools } = makeCtx()
  applyForwardTools(ctx, { manager })
  const result = await tools.get('forward_open').execute({ alias: 'target', type: 'L', bind: '8080', dest: 'db:5432' })
  assert.equal(result.id, 'fwd-2')
  assert.deepEqual(manager.calls[0], ['open', { alias: 'target', type: 'L', bind: '8080', dest: 'db:5432' }])
})

await check('forward_list 空/非空都能渲染', async () => {
  const manager = makeManager()
  const { ctx, tools } = makeCtx()
  applyForwardTools(ctx, { manager })
  const result = await tools.get('forward_list').execute({})
  assert.equal(result.count, 1)
  assert.ok(result.text.includes('fwd-1'))
})

await check('forward_close 透传 id', async () => {
  const manager = makeManager()
  const { ctx, tools } = makeCtx()
  applyForwardTools(ctx, { manager })
  const result = await tools.get('forward_close').execute({ id: 'fwd-1' })
  assert.ok(result.text.includes('fwd-1'))
  assert.deepEqual(manager.calls[0], ['close', 'fwd-1'])
})

console.log('\nforward_open 审批')

await check('policy=ask → ask', async () => {
  const manager = makeManager()
  const { ctx, hooks } = makeCtx('ask')
  applyForwardTools(ctx, { manager })
  const result = await hooks.get('tools/pre-execute')(
    { name: 'forward_open', arguments: { alias: 'target', type: 'L', bind: '8080', dest: 'db:5432' }, agent: { session: {} } },
    async () => 'next',
  )
  assert.equal(result.kind, 'ask')
  assert.ok(result.displayReason.zh.includes('SSH 隧道'))
})

await check('policy=never → deny', async () => {
  const manager = makeManager()
  const { ctx, hooks } = makeCtx('never')
  applyForwardTools(ctx, { manager })
  const result = await hooks.get('tools/pre-execute')(
    { name: 'forward_open', arguments: { alias: 'target' }, agent: { session: {} } },
    async () => 'next',
  )
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('/permission'))
})

await check('forward_close 免审批', async () => {
  const manager = makeManager()
  const { ctx, hooks } = makeCtx('never')
  applyForwardTools(ctx, { manager })
  let nextCalled = false
  await hooks.get('tools/pre-execute')(
    { name: 'forward_close', arguments: { id: 'fwd-1' }, agent: { session: {} } },
    async () => {
      nextCalled = true
    },
  )
  assert.equal(nextCalled, true)
})

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[FAIL] ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
