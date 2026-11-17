#!/usr/bin/env node
/**
 * 远端连接参数与临时文件名回归（纯函数，不建真连接）。
 *
 * 锁住两件事：
 *   1. SFTP 连接必须带 SSH keepalive——否则现场 NAT 断空闲 TCP 后，
 *      下一次文件操作会挂到内核超时，面板看起来像"卡死"；
 *   2. 上传/写入的临时文件名必须带随机后缀——同一毫秒的并发写不能撞名。
 *
 * 运行：node verify/remote-fs-options-test.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sshConnectOptions, tempPath } from '../lib/remote-fs.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error?.stack ?? error}`)
  }
}

console.log('\n远端连接参数')

test('临时文件名带目标、标签与随机后缀', () => {
  const name = tempPath('/tmp/日志.txt', 'upload')
  assert.ok(name.startsWith('/tmp/日志.txt.dsh-twb-upload-'))
  assert.ok(name.endsWith('.tmp'))
  assert.match(name, /-[0-9a-f]{8}\.tmp$/)
})

test('同一毫秒内连续生成 1000 个临时名互不重复', () => {
  const seen = new Set()
  for (let index = 0; index < 1000; index += 1) seen.add(tempPath('/tmp/a.bin', 'upload'))
  assert.strictEqual(seen.size, 1000)
})

test('密码认证：只带 password，不带 privateKey', () => {
  const options = sshConnectOptions(
    { host: '10.0.0.1', port: 2222, username: 'root', auth: 'password', password: 'secret' },
    {},
  )
  assert.strictEqual(options.host, '10.0.0.1')
  assert.strictEqual(options.port, 2222)
  assert.strictEqual(options.username, 'root')
  assert.strictEqual(options.password, 'secret')
  assert.strictEqual(options.privateKey, undefined)
  assert.strictEqual(options.readyTimeout, 15000)
  assert.strictEqual(options.keepaliveInterval, 15000)
  assert.strictEqual(options.keepaliveCountMax, 4)
})

test('私钥认证：读取 keyPath，不带 password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twb-key-'))
  const keyPath = path.join(dir, 'id_test')
  fs.writeFileSync(keyPath, 'PRIVATE-KEY')
  try {
    const options = sshConnectOptions(
      { host: 'box', username: 'deploy', auth: 'key', keyPath },
      {},
    )
    assert.deepStrictEqual(options.privateKey, Buffer.from('PRIVATE-KEY'))
    assert.strictEqual(options.password, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH_TWB_FS_KEEPALIVE_MS=0 可关闭保活', () => {
  const options = sshConnectOptions(
    { host: 'box', username: 'u', auth: 'password', password: 'p' },
    { DSH_TWB_FS_KEEPALIVE_MS: '0' },
  )
  assert.strictEqual(options.keepaliveInterval, 0)
})

test('保活环境变量非法时回落到默认 15 秒', () => {
  const options = sshConnectOptions(
    { host: 'box', username: 'u', auth: 'password', password: 'p' },
    { DSH_TWB_FS_KEEPALIVE_MS: 'not-a-number' },
  )
  assert.strictEqual(options.keepaliveInterval, 15000)
})

console.log(`\n== 远端连接参数：${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
