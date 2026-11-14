#!/usr/bin/env node
/**
 * 看门狗浏览器信号回归（纯对象，不需要真实 HTTP）。
 *
 * 2026-11-07 事故的触发点之一：服务器重启后没人开页面，看门狗却把
 * “进程活着”当成“客户端加载失败”，120 秒后改了补丁。v0.9.2 起只认
 * 文档导航和客户端静态资源，API 轮询、favicon、探活、报到信标都不算。
 *
 * 运行：node verify/browser-signal-test.mjs
 */
import assert from 'node:assert'
import { isClientLoadRequest } from '../lib/index.js'

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

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/** 造一个最小请求对象。 */
function request(url, headers = {}, method = 'GET') {
  return { url, method, headers: { 'user-agent': UA, ...headers } }
}

check('文档导航（sec-fetch-mode: navigate）算', () => {
  assert.strictEqual(isClientLoadRequest(request('/?token=x', { 'sec-fetch-mode': 'navigate' })), true)
})

check('只有 Accept: text/html 的 GET 也算（旧浏览器兜底）', () => {
  assert.strictEqual(isClientLoadRequest(request('/', { accept: 'text/html,application/xhtml+xml' })), true)
})

check('客户端主包 /assets/ 算', () => {
  assert.strictEqual(isClientLoadRequest(request('/assets/index-abc.js', { accept: '*/*' })), true)
})

check('客户端插件包 /plugins/ 算', () => {
  assert.strictEqual(
    isClientLoadRequest(request('/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=abc', { accept: '*/*' })),
    true,
  )
})

check('旧页面的 API 轮询不算', () => {
  assert.strictEqual(
    isClientLoadRequest(request('/api/session/list', { accept: '*/*', 'sec-fetch-mode': 'cors' })),
    false,
  )
})

check('favicon 不算', () => {
  assert.strictEqual(isClientLoadRequest(request('/favicon.ico', { accept: 'image/avif,image/webp' })), false)
})

check('boot.gif 报到不算失败信号', () => {
  assert.strictEqual(isClientLoadRequest(request('/__dsh-terminal-workbench/boot.gif', { accept: 'image/gif' })), false)
})

check('本插件自己的 API 不算', () => {
  assert.strictEqual(
    isClientLoadRequest(request('/__dsh-terminal-workbench/bookmarks.json', { accept: 'application/json' })),
    false,
  )
})

check('带探针标记的请求不算', () => {
  assert.strictEqual(
    isClientLoadRequest(request('/', { 'sec-fetch-mode': 'navigate', 'x-dsh-terminal-workbench-probe': '1' })),
    false,
  )
})

check('非浏览器 UA（curl）不算', () => {
  assert.strictEqual(
    isClientLoadRequest({ url: '/', method: 'GET', headers: { 'user-agent': 'curl/8.5.0', accept: 'text/html' } }),
    false,
  )
})

check('POST 即使带 text/html 也不算导航', () => {
  assert.strictEqual(isClientLoadRequest(request('/', { accept: 'text/html' }, 'POST')), false)
})

check('空请求对象不抛错', () => {
  assert.strictEqual(isClientLoadRequest({}), false)
  assert.strictEqual(isClientLoadRequest(undefined), false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
