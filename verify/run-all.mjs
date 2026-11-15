#!/usr/bin/env node
/**
 * 统一回归入口：语法检查 + verify/ 下全部测试。
 *
 * 为什么需要它：测试文件是按阶段长出来的，单跑要靠记忆或翻文档；
 * 一个入口才能让"改完跑一遍"变成习惯，也方便以后接 CI。
 *
 * 运行：node verify/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const syntaxTargets = [
  'client.js',
  'client.fs-panel.js',
  'client.terminal.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => path.join('lib', name)),
]

console.log('\n== 语法检查')
let syntaxFailed = 0
for (const relative of syntaxTargets) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  })
  if (result.status === 0) {
    console.log(`  ✓ ${relative}`)
  } else {
    syntaxFailed += 1
    console.log(`  ✗ ${relative}`)
    process.stderr.write(result.stderr ?? '')
  }
}

const tests = fs
  .readdirSync(here)
  .filter((name) => /-test\.(mjs|cjs)$/.test(name))
  .sort()

console.log(`\n== 回归测试（${tests.length} 个文件）`)
const failures = []
for (const name of tests) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [path.join(here, name)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0) {
    const last = String(result.stdout ?? '').trim().split('\n').pop() ?? ''
    console.log(`  ✓ ${name}（${elapsed}s）${last === '' ? '' : ` — ${last}`}`)
  } else {
    failures.push({ name, stdout: result.stdout, stderr: result.stderr, status: result.status })
    console.log(`  ✗ ${name}（${elapsed}s，退出码 ${result.status}）`)
  }
}

console.log(`\n== 汇总：语法 ${syntaxTargets.length - syntaxFailed}/${syntaxTargets.length}，测试 ${tests.length - failures.length}/${tests.length}`)
if (failures.length > 0 || syntaxFailed > 0) {
  for (const failure of failures) {
    console.error(`\n[FAIL] ${failure.name}`)
    process.stderr.write(failure.stdout ?? '')
    process.stderr.write(failure.stderr ?? '')
  }
  process.exitCode = 1
}
