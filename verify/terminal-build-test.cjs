#!/usr/bin/env node
/**
 * 渲染 chunk 构建源回归：确认源码、产物与入口缓存标记三者一致。
 *
 * 背景：0.8.0 之前 client.terminal.js 曾出现"产物有功能、源码没有"的手工补丁，
 * 导致构建不可复现。这里把关键能力钉在源码与产物两侧，防止再次漂移。
 *
 * 运行：node verify/terminal-build-test.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const source = read('src/terminal.js')
const chunk = read('client.terminal.js')
const entry = read('client.js')
const pkg = JSON.parse(read('package.json'))

let passed = 0
let failed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

/* 1. 入口末尾的 chunk-rev 必须与产物首 12 位哈希一致，否则浏览器会吃旧缓存。 */
test('client.js 的 chunk-rev 与 client.terminal.js 哈希一致', () => {
  const match = entry.match(/\/\* chunk-rev: ([0-9a-f]{12}) \*\/\s*$/)
  assert.ok(match, 'client.js 末尾应有 chunk-rev 标记')
  const actual = crypto.createHash('sha256').update(chunk).digest('hex').slice(0, 12)
  assert.strictEqual(match[1], actual)
})

/* 2. 构建源文件齐全，且 npm 包会把它们带上。 */
test('构建源文件齐全', () => {
  for (const relative of [
    'build.mjs',
    'src/terminal.js',
    'src/log-export.js',
    'src/log-directory-store.js',
    'src/quick-command-runner.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `${relative} 应存在`)
  }
})

test('package.json 暴露构建脚本与源码', () => {
  assert.strictEqual(pkg.scripts && pkg.scripts.build, 'node build.mjs')
  assert.ok(Array.isArray(pkg.files))
  assert.ok(pkg.files.includes('build.mjs'), 'files 应包含 build.mjs')
  assert.ok(pkg.files.includes('src'), 'files 应包含 src')
  const dev = pkg.devDependencies ?? {}
  for (const name of [
    'esbuild',
    '@xterm/xterm',
    '@xterm/addon-fit',
    '@xterm/addon-search',
    '@xterm/addon-webgl',
    '@xterm/addon-web-links',
  ]) {
    assert.ok(dev[name], `devDependencies 应包含 ${name}`)
  }
})

/* 3. 主题：设置里的 id 交给主 chunk 的共享注册表解析，失败回退 electerm 默认。 */
test('源码：主题解析走 window 共享注册表并回退默认主题', () => {
  assert.match(source, /window\.__dshTerminalWorkbenchThemes/)
  assert.match(source, /themes\.resolve\(id\)/)
  assert.match(source, /readSettingsStore\(\)\.theme/)
  assert.match(source, /colors \|\| ELECTERM_THEME/)
})

test('源码：监听 themes-ready，并在卸载时移除', () => {
  assert.match(source, /__twbReadyEv/)
  assert.match(source, /window\.addEventListener\(__twbReadyEv, __twbApplyTheme\)/)
  assert.match(source, /window\.removeEventListener\(__twbReadyEv, __twbApplyTheme\)/)
})

/* 4. 渲染实例句柄：主 chunk 的焦点恢复/增强功能依赖它。 */
test('源码：xterm.open 后暴露 __dshXterm 句柄', () => {
  const open = source.indexOf('xterm.open(node)')
  const expose = source.indexOf('node.__dshXterm = xterm')
  assert.ok(open >= 0, '应调用 xterm.open(node)')
  assert.ok(expose > open, '__dshXterm 应在 open 之后设置')
})

/* 5. 初始命令：支持用 \r 分隔多行，逐行留出 140ms 处理时间。 */
test('源码：initialInput 按 \\r 分段并延时写入', () => {
  assert.match(source, /raw\.indexOf\('\\r'\) === -1/)
  assert.match(source, /raw\.split\('\\r'\)/)
  assert.match(source, /index \* 140/)
  assert.match(source, /markInitialInputSent\(tabId, props\.initialInput\)/)
})

/* 6. 快捷指令：执行前后都把焦点还给终端。 */
test('源码：快捷指令执行前后恢复终端焦点', () => {
  assert.match(source, /\.xterm-helper-textarea/)
  assert.match(source, /focusTerminal\(\)/)
  assert.match(source, /runQuick\(item\)\.finally\(focusTerminal\)/)
})

/* 7. 产物侧：上面的能力必须真的进了 chunk，而不是只在源码里。 */
test('产物：包含主题、句柄、分段输入与焦点恢复', () => {
  for (const marker of [
    '__dshTerminalWorkbenchThemes',
    '__dshXterm',
    'themes-ready',
    'xterm-helper-textarea',
    'split("\\r")',
    '140',
  ]) {
    assert.ok(chunk.includes(marker), `client.terminal.js 应包含 ${marker}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
