#!/usr/bin/env node
/**
 * 相机同源 WebSocket 代理回归（不碰真相机 / 真 go2rtc）。
 *
 * 覆盖：
 *   - 正常 Upgrade：转发到假 go2rtc，双向字节透传；
 *   - 不同 Origin 拒绝（防跨站 WebSocket 劫持）；
 *   - 非法流名 / go2rtc 未运行返回 503；
 *   - registerUpgrade 注册的是本插件的精确路径。
 *
 * 运行：node verify/camera-ws-proxy-test.mjs
 */
import assert from 'node:assert'
import http from 'node:http'
import { cameraUpgradeHandler, registerCameraUpgrade } from '../lib/camera-api.js'

const STREAM = 'cam_0123456789ab'
const ACCEPT = 'dsh-test-accept'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const upstreamServer = http.createServer((req, res) => {
  res.writeHead(404)
  res.end('not found')
})
upstreamServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://upstream')
  if (url.pathname !== '/api/ws' || url.searchParams.get('src') !== STREAM) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`,
  )
  if (head.length > 0) socket.write(head)
  socket.on('data', (chunk) => socket.write(chunk))
  socket.on('error', () => socket.destroy())
})
const upstreamPort = await listen(upstreamServer)

const proxyServer = http.createServer((req, res) => {
  res.writeHead(404)
  res.end('no route')
})
const manager = { running: true, port: upstreamPort }
const upgradeHandler = cameraUpgradeHandler(manager)
proxyServer.on('upgrade', upgradeHandler)
const detach = () => proxyServer.off('upgrade', upgradeHandler)
const proxyPort = await listen(proxyServer)

/* Upgrade 后的 socket 不受 closeAllConnections 管理，自己记一份，结束时销毁。 */
const sockets = new Set()
for (const server of [upstreamServer, proxyServer]) {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
}

function requestUpgrade(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    })
    req.on('upgrade', (response, socket, head) => resolve({ kind: 'upgrade', response, socket, head }))
    req.on('response', (response) => {
      response.resume()
      resolve({ kind: 'response', response })
    })
    req.on('error', reject)
    req.end()
  })
}

function readOnce(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待数据超时')), 2000)
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      resolve(chunk)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

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

await check('正常 Upgrade：转发到 go2rtc 并双向透传', async () => {
  const result = await requestUpgrade(`/__dsh-terminal-workbench/camera/ws?src=${STREAM}`, {
    Origin: `http://127.0.0.1:${proxyPort}`,
  })
  assert.strictEqual(result.kind, 'upgrade')
  assert.strictEqual(result.response.statusCode, 101)
  assert.strictEqual(result.response.headers['sec-websocket-accept'], ACCEPT)
  result.socket.write('hello-camera')
  const echoed = await readOnce(result.socket)
  assert.strictEqual(echoed.toString(), 'hello-camera')
  result.socket.destroy()
})

await check('不同 Origin：403 拒绝', async () => {
  const result = await requestUpgrade(`/__dsh-terminal-workbench/camera/ws?src=${STREAM}`, {
    Origin: 'http://evil.example',
  })
  assert.strictEqual(result.kind, 'response')
  assert.strictEqual(result.response.statusCode, 403)
})

await check('非法流名：503 拒绝', async () => {
  const result = await requestUpgrade('/__dsh-terminal-workbench/camera/ws?src=../secret', {
    Origin: `http://127.0.0.1:${proxyPort}`,
  })
  assert.strictEqual(result.kind, 'response')
  assert.strictEqual(result.response.statusCode, 503)
})

await check('go2rtc 未运行：503 拒绝', async () => {
  manager.running = false
  try {
    const result = await requestUpgrade(`/__dsh-terminal-workbench/camera/ws?src=${STREAM}`, {
      Origin: `http://127.0.0.1:${proxyPort}`,
    })
    assert.strictEqual(result.kind, 'response')
    assert.strictEqual(result.response.statusCode, 503)
  } finally {
    manager.running = true
  }
})

await check('registerUpgrade 注册本插件的精确路径', () => {
  const registered = []
  const disposer = registerCameraUpgrade(
    {
      registerUpgrade(route) {
        registered.push(route)
        return () => {}
      },
    },
    manager,
  )
  assert.strictEqual(registered.length, 1)
  assert.strictEqual(registered[0].path, '/__dsh-terminal-workbench/camera/ws')
  assert.strictEqual(typeof registered[0].handler, 'function')
  assert.strictEqual(typeof disposer, 'function')
})

await check('没有 registerUpgrade 的旧 webServer：安全跳过', () => {
  const disposer = registerCameraUpgrade({}, manager)
  assert.strictEqual(typeof disposer, 'function')
  assert.doesNotThrow(() => disposer())
})

detach()
for (const socket of sockets) socket.destroy()
sockets.clear()
proxyServer.closeAllConnections?.()
upstreamServer.closeAllConnections?.()
proxyServer.close()
upstreamServer.close()
console.log(`\n== 相机 WebSocket 代理：${passed}/${passed + failures.length} 通过`)
if (failures.length > 0) process.exitCode = 1
