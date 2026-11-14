#!/usr/bin/env node
/**
 * 启动自救补丁改写回归（纯文本，不需要真实 DSH）。
 *
 * 覆盖 2026-11-07 事故的根因：只把 ui-layout 改回启用、却没禁用本插件，
 * 会留下两个 root 槽注册者，下次启动直接白屏。
 *
 * 运行：node verify/rescue-patch-test.mjs
 */
import assert from 'node:assert'
import { disableEntries, restoreEntries } from '../lib/index.js'

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

const PATCH = `# 终端工作台：一个插件同时接管布局层与终端渲染层。
- id: ui-layout
  disabled: true

- id: ui-sidebar-terminal
  disabled: true

- insert:
    - id: terminal-workbench
      name: 'dsh-terminal-workbench'
`

check('restoreEntries 只把 ui-layout 改回启用', () => {
  const next = restoreEntries(PATCH, ['ui-layout'])
  assert.match(next, /- id: ui-layout\n  disabled: false/)
  assert.match(next, /- id: ui-sidebar-terminal\n  disabled: true/)
  assert.match(next, /- id: terminal-workbench\n      name:/)
})

check('自救同时还原内置终端 ui-sidebar-terminal', () => {
  const next = restoreEntries(PATCH, ['ui-layout', 'ui-sidebar-terminal'])
  assert.match(next, /- id: ui-layout\n  disabled: false/)
  assert.match(next, /- id: ui-sidebar-terminal\n  disabled: false/)
})

check('disableEntries 在 insert 条目里补出对齐的 disabled: true', () => {
  const next = disableEntries(PATCH, ['terminal-workbench'])
  assert.match(next, /    - id: terminal-workbench\n      disabled: true\n      name:/)
})

check('组合改写后：ui-layout 启用 + 本插件禁用（事故混合态不会出现）', () => {
  const next = disableEntries(restoreEntries(PATCH, ['ui-layout', 'ui-sidebar-terminal']), ['terminal-workbench'])
  assert.match(next, /- id: ui-layout\n  disabled: false/)
  assert.match(next, /- id: ui-sidebar-terminal\n  disabled: false/)
  assert.match(next, /    - id: terminal-workbench\n      disabled: true\n      name:/)
  assert.doesNotMatch(next, /- id: terminal-workbench\n      name:/)
})

check('disableEntries 幂等：第二次改写不再变化', () => {
  const once = disableEntries(PATCH, ['terminal-workbench'])
  assert.strictEqual(disableEntries(once, ['terminal-workbench']), once)
})

check('已有 disabled: false 时改成 true', () => {
  const text = `- id: terminal-workbench\n  disabled: false\n  name: x\n`
  assert.match(disableEntries(text, ['terminal-workbench']), /disabled: true/)
})

check('没有命中 id 时原样返回', () => {
  assert.strictEqual(disableEntries(PATCH, ['not-here']), PATCH)
})

check('不误改注释里的 disabled: true', () => {
  const text = `# - id: terminal-workbench\n#   disabled: true\n- id: other\n  disabled: false\n`
  assert.strictEqual(disableEntries(text, ['terminal-workbench']), text)
})

check('条目后有空行时仍插在本条目内', () => {
  const text = `- id: terminal-workbench\n  name: x\n\n- id: other\n  disabled: false\n`
  const next = disableEntries(text, ['terminal-workbench'])
  assert.match(next, /- id: terminal-workbench\n  disabled: true\n  name: x\n\n- id: other/)
})

check('profile 补丁里显式 enabled 的覆盖也能被改回禁用', () => {
  const text = `- id: terminal-workbench\n  disabled: false\n  name: 'dsh-terminal-workbench'\n`
  assert.match(disableEntries(text, ['terminal-workbench']), /disabled: true/)
})

check('profile 补丁里带 config 的 ui-layout 只改 disabled，不动 config', () => {
  const text = `- id: ui-layout\n  disabled: true\n  config:\n    sidebar: 280\n`
  const next = restoreEntries(text, ['ui-layout'])
  assert.match(next, /- id: ui-layout\n  disabled: false\n  config:\n    sidebar: 280/)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
