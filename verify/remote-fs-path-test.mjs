#!/usr/bin/env node
/**
 * 远端路径归一化回归（纯函数，不需要 SSH）。
 *
 * 运行：node verify/remote-fs-path-test.mjs
 */
import assert from 'node:assert'
import { normalizeRemotePath, PATH_RE } from '../lib/remote-fs.js'

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

function codeOf(fn) {
  try {
    fn()
  } catch (error) {
    return error?.code
  }
  return 'NO_THROW'
}

console.log('\nnormalizeRemotePath')

check('空串 → 根', () => assert.equal(normalizeRemotePath(''), '/'))
check('根保持', () => assert.equal(normalizeRemotePath('/'), '/'))
check('折叠重复斜杠', () => assert.equal(normalizeRemotePath('/a//b///c'), '/a/b/c'))
check('折叠 . 与 ..', () => assert.equal(normalizeRemotePath('/a/./b/../c'), '/a/c'))
check('根之上的 .. 被夹住', () => assert.equal(normalizeRemotePath('/../../x'), '/x'))
check('相对路径保持相对', () => assert.equal(normalizeRemotePath('a//b/'), 'a/b'))
check('纯 .. 变 .', () => assert.equal(normalizeRemotePath('..'), '.'))
check('普通路径原样', () => assert.equal(normalizeRemotePath('/etc/nginx/nginx.conf'), '/etc/nginx/nginx.conf'))
check('空格与中文保留', () => assert.equal(normalizeRemotePath('/srv/我的 文件//a.txt'), '/srv/我的 文件/a.txt'))
check('尾部斜杠去掉（根除外）', () => assert.equal(normalizeRemotePath('/srv/logs/'), '/srv/logs'))
check('NUL 拒绝', () => assert.equal(codeOf(() => normalizeRemotePath('/a\0b')), 'FS_INVALID_ARGUMENT'))

console.log('\nPATH_RE')

check('合法地址', () => {
  const match = PATH_RE.exec('remote:boxa:/etc/nginx/nginx.conf')
  assert.ok(match)
  assert.equal(match[1], 'boxa')
  assert.equal(match[2], '/etc/nginx/nginx.conf')
})

check('别名允许点与下划线', () => {
  const match = PATH_RE.exec('remote:prod_1.cn:/var/log')
  assert.ok(match)
  assert.equal(match[1], 'prod_1.cn')
})

check('必须是绝对路径', () => assert.equal(PATH_RE.test('remote:boxa:etc/passwd'), false))
check('本地路径不匹配', () => assert.equal(PATH_RE.test('/etc/passwd'), false))
check('缺少别名不匹配', () => assert.equal(PATH_RE.test('remote::/etc'), false))

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n[FAIL] ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
