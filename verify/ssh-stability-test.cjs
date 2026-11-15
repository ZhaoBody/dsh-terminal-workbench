#!/usr/bin/env node
/**
 * SSH 连接稳定性回归（纯字符串/纯函数，不建真连接）。
 *
 * 对齐 electerm 后确定的三件事：
 *   1. 保活参数：10s × 10 次（约 100 秒判死）、TCPKeepAlive、ConnectTimeout；
 *   2. 自动重连：3s→6s→12s→24s→30s，最多 5 次；认证失败不重试；
 *   3. 书签持久化：刷新页面后仍能按命令指纹找回书签，重连入口不丢。
 *
 * 运行：node verify/ssh-stability-test.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')

const CLIENT = path.join(__dirname, '..', 'client.js')
const code = fs.readFileSync(CLIENT, 'utf8')

let definition
const storage = new Map()
const localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null
  },
  setItem(key, value) {
    storage.set(key, String(value))
  },
  removeItem(key) {
    storage.delete(key)
  },
}
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { return setTimeout(fn, 0) },
    cancelAnimationFrame(id) { clearTimeout(id) },
  },
  document: {
    createElement() {
      return {
        style: {},
        dataset: {},
        setAttribute() {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        querySelector() { return null },
      }
    },
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  Node: class Node {},
  CustomEvent: class CustomEvent {
    constructor(type, options) {
      this.type = type
      this.detail = options && options.detail
    }
  },
  TextEncoder,
  btoa(value) { return Buffer.from(String(value), 'binary').toString('base64') },
  ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
  requestAnimationFrame(fn) { return setTimeout(fn, 0) },
  cancelAnimationFrame(id) { clearTimeout(id) },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const requireStub = (name) => {
  if (name === 'react') {
    return {
      lazy(value) { return value },
      Suspense: function Suspense() {},
      useState() {},
      useEffect() {},
      useRef() {},
      useCallback() {},
      useMemo() {},
      useSyncExternalStore() {},
      createElement() {},
    }
  }
  if (name === 'react-dom') return { createPortal() {} }
  if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
  if (name === '@deepseek-ai/dsh-client-store') return { defineStore() {} }
  return {}
}
const exported = definition.factory(requireStub)
const ssh = exported.__twbSsh
assert.ok(ssh, 'client.js 应导出 __twbSsh 测试缝')

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

const baseBookmark = {
  host: 'example.com',
  user: 'tester',
  port: 2222,
  auth: 'agent',
  name: 'demo',
  remoteDir: '/srv/app',
}

function optionValue(command, key) {
  const pattern = new RegExp(`-o\\s+${key}=(\\S+)`)
  const match = pattern.exec(command)
  return match === null ? undefined : match[1]
}

check('保活对齐 electerm：10s × 10 次', () => {
  const command = ssh.sshCommand(baseBookmark)
  assert.strictEqual(optionValue(command, 'ServerAliveInterval'), '10')
  assert.strictEqual(optionValue(command, 'ServerAliveCountMax'), '10')
})

check('开启 TCPKeepAlive 并限制建连超时', () => {
  const command = ssh.sshCommand(baseBookmark)
  assert.strictEqual(optionValue(command, 'TCPKeepAlive'), 'yes')
  assert.strictEqual(optionValue(command, 'ConnectTimeout'), '15')
})

check('首次连接自动接受新主机密钥，避免卡在 yes/no', () => {
  const command = ssh.sshCommand(baseBookmark)
  assert.strictEqual(optionValue(command, 'StrictHostKeyChecking'), 'accept-new')
})

check('退避序列与连接超时与实现一致', () => {
  assert.deepStrictEqual(Array.from(ssh.retryDelays), [3000, 6000, 12000, 24000, 30000])
  assert.strictEqual(ssh.connectTimeout, 50000)
})

check('退出码翻译保留原有语义', () => {
  assert.strictEqual(ssh.sshFailureOf(0), 'closed')
  assert.strictEqual(ssh.sshFailureOf(255), 'connect')
  assert.strictEqual(ssh.sshFailureOf(1), 'remote')
  assert.strictEqual(ssh.sshFailureOf(7), 'unknown')
  assert.strictEqual(ssh.sshFailureOf(undefined), undefined)
})

check('认证失败文本能识别，网络失败不误判', () => {
  assert.strictEqual(ssh.authFailureText('tester@example.com: Permission denied (publickey).'), true)
  assert.strictEqual(ssh.authFailureText('Host key verification failed.'), true)
  assert.strictEqual(ssh.authFailureText('Received disconnect: Too many authentication failures'), true)
  assert.strictEqual(ssh.authFailureText('ssh: connect to host example.com port 22: Connection timed out'), false)
  assert.strictEqual(ssh.authFailureText('ssh: connect to host example.com port 22: Connection refused'), false)
  assert.strictEqual(ssh.authFailureText(''), false)
})

check('命令指纹稳定且能区分不同命令', () => {
  assert.strictEqual(ssh.sshTextFingerprint('ssh a'), ssh.sshTextFingerprint('ssh a'))
  assert.notStrictEqual(ssh.sshTextFingerprint('ssh a'), ssh.sshTextFingerprint('ssh b'))
})

check('书签持久化：刷新后仍能按命令取回', () => {
  const command = ssh.sshCommand(baseBookmark)
  storage.clear()
  ssh.rememberSshBookmark(command, Object.assign({}, baseBookmark))
  const restored = ssh.persistedSshBookmark(command)
  assert.ok(restored, '应能从 localStorage 取回书签')
  assert.strictEqual(restored.host, 'example.com')
  assert.strictEqual(restored.port, 2222)
  assert.strictEqual(restored.remoteDir, '/srv/app')
})

check('书签持久化：相机前缀经命令记录后不丢失', () => {
  storage.clear()
  const bookmark = Object.assign({}, baseBookmark, { cameraPrefix: '192.168.20.' })
  const command = ssh.sshCommand(bookmark)
  const restored = ssh.persistedSshBookmark(command)
  assert.ok(restored, '应能从 localStorage 取回书签')
  assert.strictEqual(restored.cameraPrefix, '192.168.20.', '相机前缀映射必须随书签一起持久化')
  assert.strictEqual(restored.host, 'example.com')
})

check('书签持久化：损坏的存储不抛异常', () => {
  storage.set('dsh-terminal-workbench.ssh-bookmarks', '{not json')
  assert.strictEqual(ssh.persistedSshBookmark('ssh a'), undefined)
})

check('书签持久化：超过上限时淘汰最旧条目', () => {
  storage.clear()
  for (let index = 0; index < 45; index += 1) {
    ssh.rememberSshBookmark(`ssh host-${index}`, { host: `host-${index}` })
  }
  const raw = JSON.parse(storage.get('dsh-terminal-workbench.ssh-bookmarks'))
  assert.strictEqual(Object.keys(raw).length, 40)
  assert.ok(ssh.persistedSshBookmark('ssh host-44'), '最新的条目必须保留')
  assert.strictEqual(ssh.persistedSshBookmark('ssh host-0'), undefined, '最旧的条目应被淘汰')
})

check('会话持久化：刷新后按 tabId 取回书签与最后目录', () => {
  storage.clear()
  ssh.rememberSshSession('tab-a', { bookmark: Object.assign({}, baseBookmark), cwd: '/srv/app/deep', state: 'connected' })
  const restored = ssh.persistedSshSession('tab-a')
  assert.ok(restored, '应能按 tabId 取回会话')
  assert.strictEqual(restored.bookmark.host, 'example.com')
  assert.strictEqual(restored.cwd, '/srv/app/deep')
  assert.strictEqual(restored.state, 'connected')
  assert.strictEqual(ssh.persistedSshSession('tab-b'), undefined)
})

check('终端标题：刷新后回退到持久会话里的书签名，不变成 bash', () => {
  storage.clear()
  assert.strictEqual(ssh.terminalTitleForTab('tab-title', ''), undefined)
  ssh.rememberSshSession('tab-title', {
    bookmark: Object.assign({}, baseBookmark, { name: 'CAR-02' }),
    state: 'disconnected',
  })
  assert.strictEqual(ssh.terminalTitleForTab('tab-title', ''), 'CAR-02')
  assert.strictEqual(ssh.terminalTitleForTab('tab-title', undefined), 'CAR-02')
  assert.strictEqual(ssh.terminalTitleForTab('tab-title', '  手动标题  '), '手动标题')
  assert.strictEqual(ssh.terminalBookmarkForTab('tab-title').name, 'CAR-02')
  assert.strictEqual(ssh.terminalTitleForTab('tab-none', ''), undefined)
})

check('终端标题：tabId 重新分配后按稳定内容地址恢复书签', () => {
  storage.clear()
  const contentId = 'sidebar://terminal/2fcd207a-7cf7-49fe-af9c-b5c9871ffcbc'
  ssh.rememberSshContentId('tab-old', contentId)
  ssh.rememberSshSession('tab-old', {
    bookmark: Object.assign({}, baseBookmark, { name: 'CAR-02' }),
    cwd: '/srv/app',
    state: 'disconnected',
  })
  const restored = ssh.persistedSshSession('tab-new', contentId)
  assert.ok(restored, '换了 tabId 也要能按内容地址找回')
  assert.strictEqual(restored.storedKey, 'tab-old')
  assert.strictEqual(restored.bookmark.name, 'CAR-02')
  assert.strictEqual(restored.cwd, '/srv/app')
  /* 模拟组件迁移：新键写入后，旧键单独删除不能连坐。 */
  ssh.rememberSshContentId('tab-new', contentId)
  ssh.rememberSshSession('tab-new', restored)
  ssh.forgetPersistedSshSessionKey('tab-old')
  assert.strictEqual(ssh.persistedSshSession('tab-new').bookmark.name, 'CAR-02')
  assert.strictEqual(ssh.persistedSshSession('tab-old', contentId).storedKey, 'tab-new')
  assert.strictEqual(ssh.terminalTitleForTab('tab-new', ''), 'CAR-02')
})

check('会话持久化：断开状态在刷新后保留，重连入口不会消失', () => {
  storage.clear()
  ssh.rememberSshSession('tab-down', {
    bookmark: Object.assign({}, baseBookmark),
    state: 'disconnected',
  })
  const restored = ssh.persistedSshSession('tab-down')
  assert.ok(restored)
  assert.strictEqual(restored.state, 'disconnected')
})

check('会话持久化：关闭标签后删除记录', () => {
  storage.clear()
  ssh.rememberSshSession('tab-close', { bookmark: Object.assign({}, baseBookmark), cwd: '/tmp' })
  assert.ok(ssh.persistedSshSession('tab-close'))
  ssh.forgetPersistedSshSession('tab-close')
  assert.strictEqual(ssh.persistedSshSession('tab-close'), undefined)
})

check('会话持久化：超过上限时淘汰最旧条目', () => {
  storage.clear()
  for (let index = 0; index < 45; index += 1) {
    ssh.rememberSshSession(`tab-${index}`, { bookmark: { host: `host-${index}` } })
  }
  const raw = JSON.parse(storage.get('dsh-terminal-workbench.ssh-sessions'))
  assert.strictEqual(Object.keys(raw).length, 40)
  assert.ok(ssh.persistedSshSession('tab-44'), '最新的会话必须保留')
  assert.strictEqual(ssh.persistedSshSession('tab-0'), undefined, '最旧的会话应被淘汰')
})

/* ---------- 手输 ssh：解析 / 重连 / 断线识别 ---------- */

check('手输 ssh：解析 user@host 并生成最小书签', () => {
  const parsed = ssh.parseSshCommandLine('ssh root@192.168.10.7')
  assert.ok(parsed, '应识别为 ssh 命令')
  assert.strictEqual(parsed.rawCommand, 'ssh root@192.168.10.7')
  assert.strictEqual(parsed.bookmark.host, '192.168.10.7')
  assert.strictEqual(parsed.bookmark.user, 'root')
  assert.strictEqual(parsed.bookmark.port, 22)
  assert.strictEqual(parsed.bookmark.name, '7', 'IP 末段用作标签名')
  assert.strictEqual(parsed.bookmark.manual, true)
})

check('手输 ssh：识别 -p / -l 与主机名', () => {
  const parsed = ssh.parseSshCommandLine('ssh -p 2222 -l deploy box.example.com')
  assert.ok(parsed)
  assert.strictEqual(parsed.bookmark.port, 2222)
  assert.strictEqual(parsed.bookmark.user, 'deploy')
  assert.strictEqual(parsed.bookmark.host, 'box.example.com')
})

check('手输 ssh：跳过带参数的选项，不把参数当主机', () => {
  const parsed = ssh.parseSshCommandLine('ssh -i ~/.ssh/id_ed25519 -J jump@10.0.0.1 -o StrictHostKeyChecking=no root@192.168.10.7')
  assert.ok(parsed)
  assert.strictEqual(parsed.bookmark.host, '192.168.10.7')
  assert.strictEqual(parsed.bookmark.user, 'root')
})

check('手输 ssh：非 ssh / 管道 / 多行 / 工作台命令不误判', () => {
  assert.strictEqual(ssh.parseSshCommandLine('ls -la'), undefined)
  assert.strictEqual(ssh.parseSshCommandLine('echo ssh root@1.2.3.4'), undefined)
  assert.strictEqual(ssh.parseSshCommandLine('ssh root@1.2.3.4 | tee log'), undefined)
  assert.strictEqual(ssh.parseSshCommandLine('ssh root@1.2.3.4\nls'), undefined)
  assert.strictEqual(ssh.parseSshCommandLine(''), undefined)
  assert.strictEqual(
    ssh.parseSshCommandLine("ssh -t root@1.2.3.4 'printf \\033]777;twb-ssh-exit;rc=%s\\007'"),
    undefined,
    '工作台生成的命令走书签路径，不重复解析',
  )
})

check('手输 ssh：重连原样重放 rawCommand，保留用户参数', () => {
  const command = 'ssh -i ~/.ssh/id_ed25519 -p 2222 deploy@box.example.com'
  const parsed = ssh.parseSshCommandLine(command)
  const reconnect = ssh.sshReconnectCommand({
    bookmark: parsed.bookmark,
    rawCommand: parsed.rawCommand,
    manual: true,
    cwd: '/should/not/be/used',
  })
  assert.strictEqual(reconnect, command)
})

check('书签会话：重连仍走 sshCommand 并带上最后目录', () => {
  const command = ssh.sshReconnectCommand({
    bookmark: Object.assign({}, baseBookmark),
    cwd: '/srv/app/deep',
  })
  assert.ok(command.startsWith('ssh '), '应是完整 ssh 命令')
  assert.ok(command.includes('-p 2222'), '端口应保留')
  /* 远端引导脚本走 base64：解出来确认 cd 到最后目录。 */
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)
  assert.ok(match, '应包含 base64 引导脚本')
  const bootstrap = Buffer.from(match[1], 'base64').toString('utf8')
  assert.ok(bootstrap.includes('cd /srv/app/deep'), '应回到最后目录')
})

check('重连命令：会话为空时不抛异常', () => {
  assert.strictEqual(ssh.sshReconnectCommand(undefined), '')
  assert.strictEqual(ssh.sshReconnectCommand(null), '')
  assert.strictEqual(ssh.sshReconnectCommand({}), '')
})

check('会话持久化：手输 ssh 的 rawCommand 与 manual 标记可恢复', () => {
  storage.clear()
  ssh.rememberSshSession('tab-manual', {
    bookmark: { host: '192.168.10.7', user: 'root', port: 22, name: '7', manual: true },
    rawCommand: 'ssh -p 22 root@192.168.10.7',
    manual: true,
  })
  const restored = ssh.persistedSshSession('tab-manual')
  assert.ok(restored)
  assert.strictEqual(restored.rawCommand, 'ssh -p 22 root@192.168.10.7')
  assert.strictEqual(restored.manual, true)
})

check('断线文本：识别 client_loop / Broken pipe 等明确结束语', () => {
  assert.strictEqual(ssh.disconnectText('client_loop: send disconnect: Broken pipe'), true)
  assert.strictEqual(ssh.disconnectText('Connection to 192.168.10.7 closed by remote host.'), true)
  assert.strictEqual(ssh.disconnectText('Connection reset by peer'), true)
  assert.strictEqual(ssh.disconnectText('Timeout, server 192.168.10.7 not responding.'), true)
  assert.strictEqual(ssh.disconnectText('ssh: connect to host 192.168.10.7 port 22: Connection refused'), true)
  assert.strictEqual(ssh.disconnectText('total 48\ndrwxr-xr-x 2 root root'), false, '普通输出不误判')
  assert.strictEqual(ssh.disconnectText(''), false)
})

check('断线文本：本地 shell 的「已终止」只在最后几行算数', () => {
  assert.strictEqual(ssh.disconnectText('ssh root@host\n已终止\nuser@pc:~$'), true)
  assert.strictEqual(ssh.disconnectText('已终止'), true, '只打到「已终止」也应立即判开')
  assert.strictEqual(
    ssh.disconnectText('已终止\nuser@pc:~$ ssh root@host'),
    false,
    '重连命令已敲下时，旧的「已终止」不能把新连接判开',
  )
  const old = ['Terminated', 'line 1', 'line 2', 'line 3', 'line 4'].join('\n')
  assert.strictEqual(ssh.disconnectText(old), false, '历史里的 Terminated 不应误判')
  assert.strictEqual(
    ssh.disconnectText('已终止\nubuntu@pc:~/Documents/project\n-2103-2110$'),
    true,
    '提示符折行时也要能识别',
  )
  assert.strictEqual(
    ssh.disconnectText('已终止\nubuntu@pc:~/Documents/project\n-2103-2110$ ssh root@host'),
    false,
    '折行提示符后面已敲新命令时不误判',
  )
})

check('屏幕兜底：强断线文本 + 本地空提示符才判开（截图场景）', () => {
  const text = [
    'ubuntu@ubuntu-pc:~/Documents/deepseek-harness/项目/HY3-02-2103-2110$ ssh root@192.168.10.7',
    'client_loop: send disconnect: Broken pipe',
    'ubuntu@ubuntu-pc:~/Documents/deepseek-harness/项目/HY3-02-2103-2110$',
  ].join('\n')
  assert.strictEqual(ssh.disconnectTextAtPrompt(text), true)
  assert.strictEqual(
    ssh.disconnectTextAtPrompt('client_loop: send disconnect: Broken pipe\n[user@host ~]$'),
    true,
    'RHEL 风格提示符也要识别',
  )
})

check('屏幕兜底：没有回到本地提示符时不判开', () => {
  assert.strictEqual(ssh.disconnectTextAtPrompt('client_loop: send disconnect: Broken pipe'), false)
  assert.strictEqual(
    ssh.disconnectTextAtPrompt('client_loop: send disconnect: Broken pipe\nread() failed: Connection reset by peer'),
    false,
  )
})

check('屏幕兜底：裸 Broken pipe 不当作强信号', () => {
  assert.strictEqual(ssh.disconnectTextAtPrompt('remote log: Broken pipe\nubuntu@pc:~$'), false)
  assert.strictEqual(ssh.disconnectTextAtPrompt('Broken pipe\n$'), false)
})

check('屏幕兜底：提示符后已经敲了新命令时不判开', () => {
  const text = [
    'client_loop: send disconnect: Broken pipe',
    'ubuntu@pc:~$ ssh root@192.168.10.7',
  ].join('\n')
  assert.strictEqual(ssh.disconnectTextAtPrompt(text), false)
})

check('屏幕兜底：断线文本超出最后 4 行不判开', () => {
  const text = [
    'client_loop: send disconnect: Broken pipe',
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'ubuntu@pc:~$',
  ].join('\n')
  assert.strictEqual(ssh.disconnectTextAtPrompt(text), false)
})

check('屏幕兜底：提示符折行也能判开', () => {
  const text = [
    'client_loop: send disconnect: Broken pipe',
    'ubuntu@pc:~/Documents/deepseek-harness/项目/HY3-02-2103-2110',
    '-2110$',
  ].join('\n')
  assert.strictEqual(ssh.disconnectTextAtPrompt(text), true)
})

check('屏幕兜底：认证失败 + 本地提示符也判开', () => {
  const text = ['Permission denied (publickey).', 'user@pc:~$'].join('\n')
  assert.strictEqual(ssh.disconnectTextAtPrompt(text), true)
})

function fakeTerm(lines) {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: lines.length - 1,
        getLine(index) {
          const text = lines[index]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    },
  }
}

check('现场恢复：从回滚缓冲里找回最后一条 ssh 命令', () => {
  const term = fakeTerm([
    'user@pc:~$ ssh root@192.168.10.7',
    'client_loop: send disconnect: Broken pipe',
    'user@pc:~$ ',
  ])
  assert.strictEqual(ssh.sshCommandFromBuffer(term, 200), 'ssh root@192.168.10.7')
})

check('现场恢复：不把 echo / 普通输出里的 ssh 当成命令', () => {
  const term = fakeTerm([
    'user@pc:~$ echo ssh root@192.168.10.7',
    'echo ssh root@192.168.10.7: not found',
    'user@pc:~$ ',
  ])
  assert.strictEqual(ssh.sshCommandFromBuffer(term, 200), '')
})

check('光标行读取：识别带提示符的 ssh 命令', () => {
  const term = fakeTerm(['user@pc:~$ ssh -p 2222 deploy@box'])
  assert.strictEqual(ssh.sshCommandFromTermLine(term), 'ssh -p 2222 deploy@box')
})

function fakeSshTerm(lines) {
  const state = { lines: lines.slice(), writeParsed: undefined, handlers: {} }
  return {
    cols: 80,
    rows: 24,
    buffer: {
      get active() {
        return {
          baseY: 0,
          get cursorY() {
            return Math.max(0, state.lines.length - 1)
          },
          getLine(index) {
            const text = state.lines[index]
            return text === undefined ? undefined : { translateToString: () => text }
          },
        }
      },
    },
    parser: {
      registerOscHandler(code, fn) {
        state.handlers[code] = fn
      },
    },
    onData(fn) {
      state.dataHandler = fn
    },
    onWriteParsed(fn) {
      state.writeParsed = fn
    },
    pushLines(...next) {
      state.lines.push(...next)
    },
    fireWrite() {
      if (state.writeParsed !== undefined) state.writeParsed()
    },
  }
}

check('屏幕兜底接线：恢复的 connected 书签会话在挂载时补查并判开', () => {
  const tabId = 'tab-restored-check'
  ssh.sshSessions[tabId] = {
    bookmark: baseBookmark,
    state: 'connected',
    manual: false,
    retryCount: 0,
  }
  const term = fakeSshTerm([
    'client_loop: send disconnect: Broken pipe',
    'ubuntu@pc:~/project$',
  ])
  ssh.attachSshSession(tabId, term)
  assert.strictEqual(ssh.sshSessions[tabId].state, 'disconnected')
  delete ssh.sshSessions[tabId]
})

check('屏幕兜底接线：书签会话的 onWriteParsed 不再被 manual 早退跳过', () => {
  const tabId = 'tab-write-check'
  ssh.sshSessions[tabId] = {
    bookmark: baseBookmark,
    state: 'connected',
    manual: false,
    retryCount: 0,
  }
  const term = fakeSshTerm([])
  ssh.attachSshSession(tabId, term)
  assert.strictEqual(ssh.sshSessions[tabId].state, 'connected')
  term.pushLines('client_loop: send disconnect: Broken pipe', 'ubuntu@pc:~/project$')
  ssh.sshSessions[tabId].tailCheckAt = undefined
  term.fireWrite()
  assert.strictEqual(ssh.sshSessions[tabId].state, 'disconnected')
  delete ssh.sshSessions[tabId]
})

check('屏幕兜底接线：手输 ssh 保留裸 Broken pipe 宽匹配', () => {
  const tabId = 'tab-manual-check'
  ssh.sshSessions[tabId] = {
    bookmark: baseBookmark,
    state: 'connected',
    manual: true,
    retryCount: 0,
  }
  const term = fakeSshTerm([])
  ssh.attachSshSession(tabId, term)
  term.pushLines('Broken pipe')
  ssh.sshSessions[tabId].tailCheckAt = undefined
  term.fireWrite()
  assert.strictEqual(ssh.sshSessions[tabId].state, 'disconnected')
  delete ssh.sshSessions[tabId]
})

console.log(`\n== SSH 稳定性：${passed}/${passed + failures.length} 通过`)
if (failures.length > 0) {
  process.exitCode = 1
}
