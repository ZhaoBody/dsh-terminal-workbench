#!/usr/bin/env node
/**
 * 相机书签回归（纯数据逻辑，不加载 DOM / 真实相机）。
 *
 * 相机书签是右栏相机标签的数据源：IP、端口、账号、流路径、模式。
 * 用户或大模型都可以填；这里只验证归一化、存取、标签绑定这些纯逻辑，
 * 真实取流由 verify/camera-api-test.mjs 用本地假相机覆盖。
 *
 * 运行：node verify/camera-test.cjs
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
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
}
const listeners = new Map()
const fakeDom = { sessions: [], tabs: [], activePane: null, session: null }
function fakeTabElement(tabId, selected, active) {
  return {
    attrs: { 'data-dockkit-tab': tabId, 'aria-selected': selected ? 'true' : 'false' },
    getAttribute(name) { return this.attrs[name] ?? null },
    closest(selector) {
      if (selector === '[hidden]') return null
      if (selector === '[data-sidebar-right-session]') return fakeDom.session
      if (selector === '[data-dockkit-pane-active], [data-dockkit-float-active]') {
        return active ? fakeDom.activePane : null
      }
      return null
    },
  }
}
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach((fn) => fn(event))
    },
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
    querySelectorAll(selector) {
      if (selector === '[data-sidebar-right-session]') return fakeDom.sessions
      if (selector === '.wb-terminal-col [data-dockkit-tab][aria-selected="true"]') {
        return fakeDom.tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
      }
      if (selector === '.wb-terminal-col [data-dockkit-tab]') return fakeDom.tabs
      return []
    },
    querySelector(selector) {
      if (selector === '[data-dockkit-pane-active], [data-dockkit-float-active]') {
        return fakeDom.activePane
      }
      return null
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
const camera = exported.__twbCamera
const ssh = exported.__twbSsh
assert.ok(camera, 'client.js 应导出 __twbCamera 测试缝')
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

check('最小书签补默认值：554 端口 / RTSP / Axis 路径', () => {
  const record = camera.normalizeCamera({ host: '192.168.10.20' })
  assert.strictEqual(record.host, '192.168.10.20')
  assert.strictEqual(record.port, 554)
  assert.strictEqual(record.mode, 'rtsp')
  assert.strictEqual(record.path, camera.defaultRtspPath)
  assert.ok(record.id.startsWith('cam-'))
})

check('旧 MJPEG 书签保留兼容模式与 80 端口', () => {
  const record = camera.normalizeCamera({ host: '192.168.10.20', mode: 'mjpeg', port: 80 })
  assert.strictEqual(record.mode, 'mjpeg')
  assert.strictEqual(record.port, 80)
  assert.strictEqual(record.path, camera.defaultMjpegPath)
  const snapshot = camera.normalizeCamera({ host: 'cam.local', mode: 'SNAPSHOT', path: '/snap' })
  assert.strictEqual(snapshot.mode, 'snapshot')
  assert.strictEqual(snapshot.port, 80)
})

check('空主机被拒绝', () => {
  assert.strictEqual(camera.normalizeCamera({ host: '' }), null)
  assert.strictEqual(camera.normalizeCamera({ host: '   ' }), null)
  assert.strictEqual(camera.normalizeCamera(null), null)
})

check('非法端口按模式回退：RTSP 554 / 兼容 80', () => {
  assert.strictEqual(camera.normalizeCamera({ host: 'a', port: 0 }).port, 554)
  assert.strictEqual(camera.normalizeCamera({ host: 'a', port: 70000 }).port, 554)
  assert.strictEqual(camera.normalizeCamera({ host: 'a', port: '554' }).port, 554)
  assert.strictEqual(camera.normalizeCamera({ host: 'a', mode: 'mjpeg', port: 0 }).port, 80)
})

check('https 与快照模式保留', () => {
  const record = camera.normalizeCamera({
    host: 'cam.local',
    port: 443,
    scheme: 'HTTPS',
    mode: 'SNAPSHOT',
    path: '/snap',
    snapshotPath: '/jpg',
    user: 'admin',
    password: 'secret',
  })
  assert.strictEqual(record.scheme, 'https')
  assert.strictEqual(record.mode, 'snapshot')
  assert.strictEqual(record.snapshotPath, '/jpg')
  assert.strictEqual(record.user, 'admin')
  assert.strictEqual(record.password, 'secret')
})

check('空流路径回退 Axis RTSP', () => {
  assert.strictEqual(camera.normalizeCamera({ host: 'a', path: '  ' }).path, camera.defaultRtspPath)
})

check('新建空白书签带主机名、root 账号与 RTSP 默认值', () => {
  const record = camera.blankCamera('192.168.10.20')
  assert.strictEqual(record.name, '192.168.10.20')
  assert.strictEqual(record.host, '192.168.10.20')
  assert.strictEqual(record.user, 'root')
  assert.strictEqual(record.password, '')
  assert.strictEqual(record.mode, 'rtsp')
  assert.strictEqual(record.port, camera.rtspPort)
  assert.strictEqual(record.path, camera.defaultRtspPath)
  assert.strictEqual(record.path, '/axis-media/media.amp?videocodec=h264')
})

check('流路径默认值：安讯士大车 / 安讯士吊具 camera=5 / 韩华大车', () => {
  assert.strictEqual(camera.defaultRtspPath, '/axis-media/media.amp?videocodec=h264')
  assert.strictEqual(
    camera.defaultSpreaderRtspPath,
    '/axis-media/media.amp?videocodec=h264&camera=5',
  )
  assert.strictEqual(camera.defaultHanwhaRtspPath, '/profile3/media.smp')
  const spreader = camera.blankCamera('192.168.10.20', { spreader: true })
  assert.strictEqual(spreader.path, camera.defaultSpreaderRtspPath)
  assert.strictEqual(
    camera.normalizeCamera({ host: 'a', spreader: true }).path,
    camera.defaultSpreaderRtspPath,
  )
  assert.strictEqual(
    camera.normalizeCamera({ host: 'a', spreader: false }).path,
    camera.defaultRtspPath,
  )
})

check('适应/铺满按相机书签记住，坏数据回退适应', () => {
  storage.clear()
  assert.strictEqual(camera.readCameraFit('cam-a'), 'contain')
  camera.writeCameraFit('cam-a', 'cover')
  assert.strictEqual(camera.readCameraFit('cam-a'), 'cover')
  assert.strictEqual(camera.readCameraFit('cam-b'), 'contain')
  storage.set('dsh-terminal-workbench.cameraFit', '{bad json')
  assert.strictEqual(camera.readCameraFit('cam-a'), 'contain')
})

check('写读往返与更新', () => {
  storage.clear()
  camera.writeCameras([])
  const first = camera.upsertCamera(camera.blankCamera('10.0.0.1'))
  assert.strictEqual(camera.readCameras().length, 1)
  assert.strictEqual(camera.cameraById(first.id).host, '10.0.0.1')
  const updated = camera.upsertCamera(Object.assign({}, first, { name: '前相机', password: 'pw' }))
  assert.strictEqual(updated.name, '前相机')
  assert.strictEqual(camera.readCameras().length, 1)
  assert.strictEqual(camera.cameraById(first.id).password, 'pw')
})

check('删除书签', () => {
  const list = camera.readCameras()
  const id = list[0].id
  camera.removeCamera(id)
  assert.strictEqual(camera.cameraById(id), undefined)
})

check('书签数量上限 100 条', () => {
  storage.clear()
  const many = Array.from({ length: 130 }, (_, index) => camera.blankCamera('10.0.0.' + index))
  camera.writeCameras(many)
  assert.strictEqual(camera.readCameras().length, 100)
})

check('坏数据不会让读取炸掉', () => {
  camera.writeCameras([])
  storage.set('dsh-terminal-workbench.cameras', '{not json')
  /* 模块级缓存会挡住重新解析，测试里显式失效。 */
  camera.reset()
  /* 跨 vm 上下文的数组原型不同，deepStrictEqual 会误报，直接看长度。 */
  assert.strictEqual(camera.readCameras().length, 0)
})

check('标签标题回退顺序：名称 → 主机 → 相机', () => {
  assert.strictEqual(camera.cameraLabel({ name: '前相机', host: '10.0.0.1' }), '前相机')
  assert.strictEqual(camera.cameraLabel({ name: '', host: '10.0.0.1' }), '10.0.0.1')
  assert.strictEqual(camera.cameraLabel(undefined), '相机')
})

check('标签绑定按「会话 + 标签」隔离并可清除', () => {
  storage.clear()
  camera.storeCameraId('s1', 'tab1', 'cam-a')
  camera.storeCameraId('s2', 'tab1', 'cam-b')
  assert.strictEqual(camera.readStoredCameraId('s1', 'tab1'), 'cam-a')
  assert.strictEqual(camera.readStoredCameraId('s2', 'tab1'), 'cam-b')
  camera.forgetCameraTab('s1', 'tab1')
  assert.strictEqual(camera.readStoredCameraId('s1', 'tab1'), '')
  assert.strictEqual(camera.readStoredCameraId('s2', 'tab1'), 'cam-b')
})

check('IPv4 主机取 /24 前缀，非法地址返回空串', () => {
  assert.strictEqual(camera.ipv4Prefix('192.168.10.20'), '192.168.10.')
  assert.strictEqual(camera.ipv4Prefix('  192.168.0.5  '), '192.168.0.')
  assert.strictEqual(camera.ipv4Prefix('192.168.10'), '')
  assert.strictEqual(camera.ipv4Prefix('192.168.10.999'), '')
  assert.strictEqual(camera.ipv4Prefix('camera.local'), '')
})

check('前缀输入归一化：可省略尾点，非法段拒绝', () => {
  assert.strictEqual(camera.normalizeCameraPrefix('192.168.10'), '192.168.10.')
  assert.strictEqual(camera.normalizeCameraPrefix('192.168.10.'), '192.168.10.')
  assert.strictEqual(camera.normalizeCameraPrefix('192.168.10.20'), '')
  assert.strictEqual(camera.normalizeCameraPrefix('192.168.999'), '')
  assert.strictEqual(camera.normalizeCameraPrefix(''), '')
})

check('IP 末位只接受 1–254', () => {
  assert.strictEqual(camera.normalizeLastOctet('20'), 20)
  assert.strictEqual(camera.normalizeLastOctet(' 1 '), 1)
  assert.strictEqual(camera.normalizeLastOctet('254'), 254)
  assert.strictEqual(camera.normalizeLastOctet('0'), null)
  assert.strictEqual(camera.normalizeLastOctet('255'), null)
  assert.strictEqual(camera.normalizeLastOctet('1.2'), null)
  assert.strictEqual(camera.normalizeLastOctet('abc'), null)
})

check('前缀 + 末位拼出完整 IP', () => {
  assert.strictEqual(camera.cameraHostFromOctet('192.168.10', '20'), '192.168.10.20')
  assert.strictEqual(camera.cameraHostFromOctet('192.168.10.', '020'), '192.168.10.20')
  assert.strictEqual(camera.cameraHostFromOctet('192.168.10.', '0'), '')
  assert.strictEqual(camera.cameraHostFromOctet('bad', '20'), '')
})

check('终端书签映射相机前缀：显式覆盖优先，留空按主机 /24', () => {
  assert.strictEqual(camera.cameraPrefixForTerminalBookmark({ host: '192.168.10.5' }), '192.168.10.')
  assert.strictEqual(
    camera.cameraPrefixForTerminalBookmark({ host: '192.168.10.5', cameraPrefix: '192.168.20.' }),
    '192.168.20.',
  )
  assert.strictEqual(
    camera.cameraPrefixForTerminalBookmark({ host: '192.168.10.5', cameraPrefix: 'bad' }),
    '192.168.10.',
  )
  assert.strictEqual(camera.cameraPrefixForTerminalBookmark(undefined), '')
})

check('相机前缀记忆：写读往返，坏值不污染', () => {
  storage.clear()
  assert.strictEqual(camera.readCameraPrefix(), '')
  assert.strictEqual(camera.writeCameraPrefix('192.168.10'), '192.168.10.')
  assert.strictEqual(camera.readCameraPrefix(), '192.168.10.')
  storage.set('dsh-terminal-workbench.cameraPrefix', 'not-an-ip')
  assert.strictEqual(camera.readCameraPrefix(), '')
})

check('前缀来源比较：字段一致时复用旧对象', () => {
  const left = {
    prefix: '192.168.10.',
    host: '192.168.10.5',
    title: 'MW8',
    source: 'terminal',
    tabId: 'tab2',
  }
  assert.strictEqual(camera.sameCameraPrefixInfo(left, left), true)
  assert.strictEqual(camera.sameCameraPrefixInfo(left, Object.assign({}, left)), true)
  assert.strictEqual(camera.sameCameraPrefixInfo(left, Object.assign({}, left, { prefix: '192.168.20.' })), false)
  assert.strictEqual(camera.sameCameraPrefixInfo(left, Object.assign({}, left, { source: 'memory' })), false)
  assert.strictEqual(camera.sameCameraPrefixInfo(null, left), false)
})

check('相机前缀排序：相机标签激活时优先最近使用的终端，不退回第一个', () => {
  const entries = [
    { tabId: 'tab-2105', selected: true, label: '2105' },
    { tabId: 'tab-camera', selected: true, label: 'camera' },
    { tabId: 'tab-2107', selected: false, label: '2107' },
  ]
  const labels = (remembered) =>
    camera
      .orderTabsForCameraPrefix(entries, remembered)
      .map((item) => item.label)
      .join(',')
  assert.strictEqual(labels('tab-2107'), '2107,2105,camera')
  assert.strictEqual(labels(''), '2105,camera,2107')
  assert.strictEqual(labels('tab-2105'), '2105,camera,2107')
  assert.strictEqual(labels('tab-closed'), '2105,camera,2107')
  assert.strictEqual(
    camera
      .orderTabsForCameraPrefix([null, entries[2], entries[0]], 'tab-2107')
      .map((item) => item.label)
      .join(','),
    '2107,2105',
  )
})

check('相机前缀记忆：相机标签激活时保持最后使用的终端，不串到 2105', () => {
  storage.clear()
  fakeDom.session = {
    getAttribute(name) { return name === 'data-sidebar-right-session' ? 's1' : null },
    closest() { return null },
  }
  fakeDom.sessions = [fakeDom.session]
  fakeDom.activePane = { id: 'pane-2107' }
  ssh.rememberSshSession('tab-2105', { bookmark: { name: '2105', host: '192.168.30.10' } })
  ssh.rememberSshSession('tab-2107', { bookmark: { name: '2107', host: '192.168.40.30' } })

  /* 用户正在 2107 终端：2107 是激活分栏里选中的标签。 */
  fakeDom.tabs = [
    fakeTabElement('tab-2105', true, false),
    fakeTabElement('tab-2107', true, true),
    fakeTabElement('tab-camera', false, true),
  ]
  assert.deepStrictEqual(
    (() => {
      const remembered = camera.rememberActiveTerminalTab()
      return { sessionId: remembered.sessionId, tabId: remembered.tabId }
    })(),
    { sessionId: 's1', tabId: 'tab-2107' },
  )

  /* 打开相机后：相机标签选中，2105 在另一个分栏里仍显示为“选中”。 */
  fakeDom.tabs = [
    fakeTabElement('tab-2105', true, false),
    fakeTabElement('tab-2107', false, true),
    fakeTabElement('tab-camera', true, true),
  ]
  assert.strictEqual(camera.rememberActiveTerminalTab().tabId, 'tab-2107')
  const info = camera.resolveCameraPrefixInfo()
  assert.strictEqual(info.prefix, '192.168.40.')
  assert.strictEqual(info.title, '2107')
  assert.strictEqual(info.tabId, 'tab-2107')

  /* 用户切回 2105 终端：跟随切换，不再记 2107。 */
  fakeDom.tabs = [
    fakeTabElement('tab-2105', true, true),
    fakeTabElement('tab-2107', false, true),
    fakeTabElement('tab-camera', false, true),
  ]
  const switched = camera.resolveCameraPrefixInfo()
  assert.strictEqual(switched.prefix, '192.168.30.')
  assert.strictEqual(switched.title, '2105')

  fakeDom.tabs = []
  fakeDom.sessions = []
  fakeDom.activePane = null
  fakeDom.session = null
})

check('按主机精确复用相机书签', () => {
  storage.clear()
  camera.writeCameras([])
  const first = camera.upsertCamera(camera.blankCamera('192.168.10.20'))
  assert.strictEqual(camera.cameraForHost('192.168.10.20').id, first.id)
  assert.strictEqual(camera.cameraForHost('192.168.10.21'), undefined)
  assert.strictEqual(camera.cameraForHost(''), undefined)
})

check('相机样式里的数字属性选择器必须加引号（否则整条规则被 CSS 丢弃）', () => {
  const bad = code.match(/\[data-[a-z-]+=\d+\]/g) || []
  assert.deepStrictEqual(bad, [], '发现未加引号的数字属性选择器：' + bad.join(', '))
})

check('顶栏码流标签：识别海康/大华主码流与子码流', () => {
  assert.strictEqual(camera.cameraStreamLabel({ path: '/Streaming/Channels/101' }), '主码流')
  assert.strictEqual(camera.cameraStreamLabel({ path: '/Streaming/Channels/102' }), '子码流')
  assert.strictEqual(camera.cameraStreamLabel({ path: '/Streaming/Channels/201' }), '主码流')
  assert.strictEqual(camera.cameraStreamLabel({ path: '/Streaming/Channels/202' }), '子码流')
  assert.strictEqual(
    camera.cameraStreamLabel({ path: '/cam/realmonitor?channel=1&subtype=0' }),
    '主码流',
  )
  assert.strictEqual(
    camera.cameraStreamLabel({ path: '/cam/realmonitor?channel=1&subtype=1' }),
    '子码流',
  )
  assert.strictEqual(camera.cameraStreamLabel({ path: '/axis-media/media.amp' }), '')
  assert.strictEqual(camera.cameraStreamLabel(null), '')
})

check('密码组归属：普通相机按车号，吊具相机按项目', () => {
  assert.strictEqual(
    camera.cameraPasswordGroupKey({ vehicle: 'CAR-02', project: '', spreader: false }),
    'vehicle:CAR-02',
  )
  assert.strictEqual(
    camera.cameraPasswordGroupKey({ vehicle: 'CAR-02', project: 'PROJ', spreader: true }),
    'project:PROJ:spreader',
  )
  assert.strictEqual(camera.cameraPasswordGroupKey({ vehicle: 'CAR-02', spreader: true }), '')
  assert.strictEqual(camera.cameraPasswordGroupKey({ project: 'PROJ' }), '')
  assert.strictEqual(
    camera.cameraPasswordGroupKey({ vehicle: '  CAR-02  ', project: '  PROJ  ', spreader: true }),
    'project:PROJ:spreader',
  )
  assert.strictEqual(camera.cameraPasswordGroupKey(null), '')
})

check('密码组标题可读，未知 key 返回空串', () => {
  assert.strictEqual(camera.cameraPasswordGroupLabel('vehicle:CAR-02'), '车号 CAR-02')
  assert.strictEqual(camera.cameraPasswordGroupLabel('project:PROJ:spreader'), '项目 PROJ · 吊具')
  assert.strictEqual(camera.cameraPasswordGroupLabel(''), '')
  assert.strictEqual(camera.cameraPasswordGroupLabel('other:x'), '')
})

check('相机书签归一化保留归属并重算组 key', () => {
  const record = camera.normalizeCamera({
    host: '192.168.10.20',
    vehicle: ' CAR-02 ',
    project: ' PROJ ',
    spreader: true,
    passwordGroup: 'stale',
  })
  assert.strictEqual(record.vehicle, 'CAR-02')
  assert.strictEqual(record.project, 'PROJ')
  assert.strictEqual(record.spreader, true)
  assert.strictEqual(record.passwordGroup, 'project:PROJ:spreader')
  const legacy = camera.normalizeCamera({ host: '192.168.10.21', password: 'old' })
  assert.strictEqual(legacy.vehicle, '')
  assert.strictEqual(legacy.project, '')
  assert.strictEqual(legacy.spreader, false)
  assert.strictEqual(legacy.passwordGroup, '')
  assert.strictEqual(legacy.password, 'old')
})

check('新建相机书签可带出终端书签的车号/项目', () => {
  const record = camera.blankCamera('192.168.10.20', { vehicle: 'CAR-02', project: 'PROJ' })
  assert.strictEqual(record.vehicle, 'CAR-02')
  assert.strictEqual(record.project, 'PROJ')
  assert.strictEqual(record.spreader, false)
  assert.strictEqual(record.passwordGroup, 'vehicle:CAR-02')
  assert.strictEqual(camera.blankCamera('192.168.10.20').vehicle, '')
})

check('终端书签归属：车号取标题，项目取分组名', () => {
  storage.set(
    'dsh-terminal-workbench.settings',
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-car', name: 'CAR' },
        { id: 'bg-proj', name: 'PROJ' },
        { id: 'bg-fake-default', name: '默认分组' },
      ],
      bookmarks: [],
    }),
  )
  const empty = camera.cameraOwnerForTerminalBookmark(undefined)
  assert.strictEqual(empty.vehicle, '')
  assert.strictEqual(empty.project, '')

  /* 未分组 / 默认分组：车号照拿，项目留空（默认分组不是项目）。 */
  const noGroup = camera.cameraOwnerForTerminalBookmark({ name: 'CAR-02', host: '192.168.10.5' })
  assert.strictEqual(noGroup.vehicle, 'CAR-02')
  assert.strictEqual(noGroup.project, '')
  const defaultGroup = camera.cameraOwnerForTerminalBookmark({ name: 'CAR-02', groupId: 'default' })
  assert.strictEqual(defaultGroup.vehicle, 'CAR-02')
  assert.strictEqual(defaultGroup.project, '')
  const namedDefault = camera.cameraOwnerForTerminalBookmark({
    name: 'CAR-02',
    groupId: 'bg-fake-default',
  })
  assert.strictEqual(namedDefault.project, '')

  /* 书签标题就是车号，分组名就是项目。 */
  const grouped = camera.cameraOwnerForTerminalBookmark({ name: 'CAR-02', groupId: 'bg-car' })
  assert.strictEqual(grouped.vehicle, 'CAR-02')
  assert.strictEqual(grouped.project, 'CAR')

  /* 旧版显式字段不再参与推导，避免和书签标题/分组打架。 */
  const legacy = camera.cameraOwnerForTerminalBookmark({
    name: '随便叫',
    vehicle: 'CAR-02',
    project: 'PROJ',
  })
  assert.strictEqual(legacy.vehicle, '随便叫')
  assert.strictEqual(legacy.project, '')

  /* 空标题 / 未知分组都安全回退。 */
  const noName = camera.cameraOwnerForTerminalBookmark({ groupId: 'bg-proj' })
  assert.strictEqual(noName.vehicle, '')
  assert.strictEqual(noName.project, 'PROJ')
  const unknownGroup = camera.cameraOwnerForTerminalBookmark({ name: 'PROJ-59', groupId: 'bg-missing' })
  assert.strictEqual(unknownGroup.vehicle, 'PROJ-59')
  assert.strictEqual(unknownGroup.project, '')

  storage.delete('dsh-terminal-workbench.settings')
})

check('密码组存取：坏数据不炸，空密码组被丢弃', () => {
  storage.clear()
  camera.writeCameraPasswordGroups({
    'vehicle:CAR-02': { user: 'root', password: 'pw-a' },
    'project:PROJ:spreader': { user: 'admin', password: '' },
    broken: null,
  })
  const groups = camera.readCameraPasswordGroups()
  assert.deepStrictEqual(Object.keys(groups), ['vehicle:CAR-02'])
  assert.strictEqual(groups['vehicle:CAR-02'].password, 'pw-a')
  storage.set(camera.passwordGroupsKey, '{bad json')
  assert.deepStrictEqual(Object.keys(camera.readCameraPasswordGroups()), [])
})

check('凭证解析：无组回退书签，有组以组为准', () => {
  storage.clear()
  const legacy = camera.normalizeCamera({ host: '10.0.0.1', user: 'root', password: 'own' })
  assert.strictEqual(camera.resolveCameraCredentials(legacy).password, 'own')
  assert.strictEqual(camera.resolveCameraCredentials(legacy).groupKey, '')

  const grouped = camera.normalizeCamera({
    host: '10.0.0.2',
    user: 'root',
    password: 'stale-own',
    vehicle: 'CAR-02',
  })
  assert.strictEqual(camera.resolveCameraCredentials(grouped).password, 'stale-own')
  camera.writeCameraPasswordGroups({ 'vehicle:CAR-02': { user: 'admin', password: 'group-pw' } })
  const resolved = camera.resolveCameraCredentials(grouped)
  assert.strictEqual(resolved.password, 'group-pw')
  assert.strictEqual(resolved.user, 'admin')
  assert.strictEqual(resolved.groupKey, 'vehicle:CAR-02')
  assert.strictEqual(resolved.groupLabel, '车号 CAR-02')
})

check('保存到密码组：新密码写入组，书签不再重复存密码', () => {
  storage.clear()
  const record = camera.normalizeCamera({
    host: '192.168.10.20',
    user: 'root',
    password: 'pw-a',
    vehicle: 'CAR-02',
  })
  const prepared = camera.applyCameraPasswordGroup(record)
  assert.strictEqual(prepared.groupKey, 'vehicle:CAR-02')
  assert.strictEqual(prepared.reused, false)
  assert.strictEqual(prepared.record.password, '')
  assert.strictEqual(prepared.record.passwordGroup, 'vehicle:CAR-02')
  const groups = camera.readCameraPasswordGroups()
  assert.strictEqual(groups['vehicle:CAR-02'].password, 'pw-a')
})

check('同组第二台相机留空即复用，改一次全组生效', () => {
  storage.clear()
  const first = camera.applyCameraPasswordGroup(
    camera.normalizeCamera({
      host: '192.168.10.20',
      user: 'root',
      password: 'pw-a',
      vehicle: 'CAR-02',
    }),
  ).record
  camera.upsertCamera(first)

  const second = camera.normalizeCamera({
    host: '192.168.10.21',
    user: 'root',
    password: '',
    vehicle: 'CAR-02',
  })
  const reused = camera.applyCameraPasswordGroup(second)
  assert.strictEqual(reused.reused, true)
  assert.strictEqual(reused.record.password, '')
  assert.strictEqual(camera.resolveCameraCredentials(reused.record).password, 'pw-a')

  /* 在第二台上改密码：组更新，第一台也跟着变。 */
  const changed = camera.applyCameraPasswordGroup(
    Object.assign({}, reused.record, { password: 'pw-b' }),
  )
  assert.strictEqual(changed.updated, true)
  assert.strictEqual(changed.record.password, '')
  assert.strictEqual(camera.resolveCameraCredentials(first).password, 'pw-b')
  assert.strictEqual(camera.resolveCameraCredentials(changed.record).password, 'pw-b')
})

check('吊具相机按项目跨车复用，不碰同车普通相机组', () => {
  storage.clear()
  const spreader = camera.applyCameraPasswordGroup(
    camera.normalizeCamera({
      host: '192.168.50.34',
      user: 'root',
      password: 'spreader-pw',
      vehicle: 'CAR-02',
      project: 'CAR',
      spreader: true,
    }),
  ).record
  const normal = camera.applyCameraPasswordGroup(
    camera.normalizeCamera({
      host: '192.168.50.20',
      user: 'root',
      password: 'normal-pw',
      vehicle: 'CAR-02',
      project: 'CAR',
    }),
  ).record
  assert.strictEqual(spreader.passwordGroup, 'project:CAR:spreader')
  assert.strictEqual(normal.passwordGroup, 'vehicle:CAR-02')
  assert.strictEqual(camera.resolveCameraCredentials(spreader).password, 'spreader-pw')
  assert.strictEqual(camera.resolveCameraCredentials(normal).password, 'normal-pw')

  /* 同项目另一台车的吊具相机留空，直接复用项目组。 */
  const otherCar = camera.applyCameraPasswordGroup(
    camera.normalizeCamera({
      host: '10.141.29.34',
      user: 'root',
      password: '',
      vehicle: 'MW1-01',
      project: 'CAR',
      spreader: true,
    }),
  )
  assert.strictEqual(otherCar.reused, true)
  assert.strictEqual(camera.resolveCameraCredentials(otherCar.record).password, 'spreader-pw')
})

check('无归属的相机保持独立密码，不会被误并组', () => {
  storage.clear()
  camera.writeCameraPasswordGroups({ 'vehicle:CAR-02': { user: 'root', password: 'pw-a' } })
  const record = camera.normalizeCamera({ host: '10.0.0.9', password: 'own' })
  const prepared = camera.applyCameraPasswordGroup(record)
  assert.strictEqual(prepared.groupKey, '')
  assert.strictEqual(prepared.record.password, 'own')
  assert.strictEqual(camera.resolveCameraCredentials(prepared.record).password, 'own')
})

check('绑定密码组后，相机书签存储里不再出现明文密码', () => {
  storage.clear()
  const record = camera.applyCameraPasswordGroup(
    camera.normalizeCamera({
      host: '192.168.10.20',
      user: 'root',
      password: 'pw-a',
      vehicle: 'CAR-02',
    }),
  ).record
  camera.upsertCamera(record)
  const raw = storage.get('dsh-terminal-workbench.cameras')
  assert.ok(raw.includes('vehicle:CAR-02'))
  assert.ok(!raw.includes('pw-a'), '书签里不应重复保存组密码')
})

check('相机密码输入框按现场要求明文显示', () => {
  const start = code.indexOf("'data-camera-form'")
  assert.ok(start > 0, '应能找到相机表单')
  const end = code.indexOf('wb-cam-hint', start)
  assert.ok(end > start, '应能找到相机表单结尾')
  const form = code.slice(start, end)
  assert.strictEqual(form.indexOf("type: 'password'"), -1, '相机表单不应使用 password 遮罩')
  assert.ok(form.indexOf("type: 'text'") >= 0, '相机密码应使用 text 输入框')
})

check('相机表单提供自动识别品牌入口', () => {
  assert.ok(code.indexOf("CAMERA_API + '/probe'") >= 0, '表单应调用宿主 /camera/probe')
  assert.ok(code.indexOf("'自动识别品牌'") >= 0, '表单应有自动识别按钮')
  assert.ok(code.indexOf('相机拒绝 RTSP 描述请求') >= 0, 'DESCRIBE 失败应有可操作提示')
  assert.ok(code.indexOf('upsertCamera(corrected)') >= 0, '识别出的路径应写回书签')
})

check('相机表单提供 H.264 码流查找入口', () => {
  assert.ok(code.indexOf("CAMERA_API + '/codec'") >= 0, '表单应调用宿主 /camera/codec')
  assert.ok(code.indexOf("'找 H.264 码流'") >= 0, '表单应有找 H.264 按钮')
  assert.ok(code.indexOf('autoSwitchH264') >= 0, '播放器报 H.265 时应自动切换')
  assert.ok(code.indexOf("'自动换 H.264'") >= 0, '错误浮层应提供自动换 H.264 按钮')
  assert.ok(code.indexOf('codecs not matched') >= 0, '应识别 go2rtc 的编码不匹配错误')
  assert.ok(code.indexOf('相机输出 H.265') >= 0, '应有 H.265 可操作提示')
})

check('相机书签归一化与新建保留来源 SSH 书签链接', () => {
  const normalized = camera.normalizeCamera({
    host: '10.0.0.5',
    terminalBookmarkId: ' bm-9 ',
  })
  assert.strictEqual(normalized.terminalBookmarkId, 'bm-9')
  const blank = camera.blankCamera('10.0.0.6', { terminalBookmarkId: ' bm-10 ' })
  assert.strictEqual(blank.terminalBookmarkId, 'bm-10')
  assert.strictEqual(camera.blankCamera('10.0.0.7').terminalBookmarkId, '')
})

check('相机书签归属随来源 SSH 书签改名/换组实时变化', () => {
  storage.clear()
  camera.reset()
  const writeBookmarks = (bookmarks) => {
    storage.set(
      'dsh-terminal-workbench.settings',
      JSON.stringify({
        bookmarkGroups: [
          { id: 'default', name: '默认分组' },
          { id: 'bg-car', name: 'CAR' },
          { id: 'bg-proj', name: 'PROJ' },
        ],
        bookmarks,
      }),
    )
  }
  writeBookmarks([{ id: 'bm-1', name: 'CAR-02', host: '192.168.10.5', groupId: 'bg-car' }])
  const record = camera.upsertCamera(
    camera.blankCamera('192.168.10.20', {
      vehicle: 'CAR-02',
      project: 'CAR',
      terminalBookmarkId: 'bm-1',
    }),
  )
  assert.strictEqual(record.terminalBookmarkId, 'bm-1')
  assert.strictEqual(camera.cameraById(record.id).vehicle, 'CAR-02')
  assert.strictEqual(camera.cameraById(record.id).project, 'CAR')
  assert.strictEqual(camera.cameraById(record.id).passwordGroup, 'vehicle:CAR-02')

  writeBookmarks([{ id: 'bm-1', name: 'CAR-09', host: '192.168.10.5', groupId: 'bg-proj' }])
  camera.reset()
  const renamed = camera.cameraById(record.id)
  assert.strictEqual(renamed.vehicle, 'CAR-09')
  assert.strictEqual(renamed.project, 'PROJ')
  assert.strictEqual(renamed.passwordGroup, 'vehicle:CAR-09')
  assert.strictEqual(renamed.terminalBookmarkId, 'bm-1')
  storage.clear()
})

check('老相机书签按车号+项目唯一匹配来源书签，歧义不硬绑', () => {
  storage.clear()
  camera.reset()
  storage.set(
    'dsh-terminal-workbench.settings',
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-car', name: 'CAR' },
        { id: 'bg-proj', name: 'PROJ' },
      ],
      bookmarks: [
        { id: 'bm-1', name: 'CAR-02', host: '192.168.10.5', groupId: 'bg-car' },
        { id: 'bm-2', name: 'PROJ-59', host: '192.168.20.5', groupId: 'bg-proj' },
        { id: 'bm-3', name: 'PROJ-59', host: '192.168.20.6', groupId: 'bg-proj' },
      ],
    }),
  )
  camera.writeCameras([
    camera.normalizeCamera({ host: '10.0.0.1', vehicle: 'CAR-02', project: 'CAR' }),
    camera.normalizeCamera({ host: '10.0.0.2', vehicle: 'PROJ-59', project: 'PROJ' }),
  ])
  const result = camera.syncCameraTerminalOwners()
  assert.strictEqual(result.linked, 1)
  assert.strictEqual(camera.cameraForHost('10.0.0.1').terminalBookmarkId, 'bm-1')
  assert.strictEqual(camera.cameraForHost('10.0.0.2').terminalBookmarkId, '')
  storage.clear()
})

check('来源 SSH 书签删除后保留上次归属快照', () => {
  storage.clear()
  camera.reset()
  storage.set(
    'dsh-terminal-workbench.settings',
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-car', name: 'CAR' },
      ],
      bookmarks: [{ id: 'bm-1', name: 'CAR-02', host: '192.168.10.5', groupId: 'bg-car' }],
    }),
  )
  const record = camera.upsertCamera(
    camera.blankCamera('10.0.0.3', {
      vehicle: 'CAR-02',
      project: 'CAR',
      terminalBookmarkId: 'bm-1',
    }),
  )
  storage.set(
    'dsh-terminal-workbench.settings',
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-car', name: 'CAR' },
      ],
      bookmarks: [],
    }),
  )
  camera.reset()
  const orphan = camera.cameraById(record.id)
  assert.strictEqual(orphan.terminalBookmarkId, 'bm-1')
  assert.strictEqual(orphan.vehicle, 'CAR-02')
  assert.strictEqual(orphan.project, 'CAR')
  storage.clear()
})

check('归属变化时旧密码组带到新组，不覆盖已有新组', () => {
  storage.clear()
  camera.reset()
  const settingsFor = (name) =>
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-car', name: 'CAR' },
      ],
      bookmarks: [{ id: 'bm-1', name, host: '192.168.10.5', groupId: 'bg-car' }],
    })
  storage.set('dsh-terminal-workbench.settings', settingsFor('CAR-02'))
  camera.writeCameraPasswordGroups({
    'vehicle:CAR-02': { user: 'root', password: 'pw-a' },
  })
  const record = camera.upsertCamera(
    camera.blankCamera('10.0.0.4', {
      vehicle: 'CAR-02',
      project: 'CAR',
      terminalBookmarkId: 'bm-1',
    }),
  )

  storage.set('dsh-terminal-workbench.settings', settingsFor('CAR-09'))
  camera.reset()
  const result = camera.syncCameraTerminalOwners()
  assert.ok(result.changed >= 1)
  assert.strictEqual(camera.readCameraPasswordGroups()['vehicle:CAR-09'].password, 'pw-a')
  const renamed = camera.cameraById(record.id)
  assert.strictEqual(renamed.passwordGroup, 'vehicle:CAR-09')
  assert.strictEqual(camera.resolveCameraCredentials(renamed).password, 'pw-a')

  /* 新组已有密码时以新组为准，不能被旧组覆盖。 */
  storage.clear()
  camera.reset()
  storage.set('dsh-terminal-workbench.settings', settingsFor('CAR-02'))
  camera.writeCameraPasswordGroups({
    'vehicle:CAR-02': { user: 'root', password: 'pw-a' },
    'vehicle:CAR-09': { user: 'root', password: 'pw-b' },
  })
  camera.upsertCamera(
    camera.blankCamera('10.0.0.5', {
      vehicle: 'CAR-02',
      project: 'CAR',
      terminalBookmarkId: 'bm-1',
    }),
  )
  storage.set('dsh-terminal-workbench.settings', settingsFor('CAR-09'))
  camera.reset()
  camera.syncCameraTerminalOwners()
  assert.strictEqual(camera.readCameraPasswordGroups()['vehicle:CAR-09'].password, 'pw-b')
  storage.clear()
})

check('相机面板归属判断：普通相机按车号，吊具相机按项目', () => {
  const normal = { vehicle: 'CAR-02', project: 'CAR', spreader: false }
  const spreader = { vehicle: 'CAR-02', project: 'CAR', spreader: true }
  assert.strictEqual(
    camera.cameraBelongsToTerminal(normal, { vehicle: 'CAR-02', project: 'CAR' }),
    true,
  )
  assert.strictEqual(
    camera.cameraBelongsToTerminal(normal, { vehicle: 'PROJ-59', project: 'PROJ' }),
    false,
  )
  assert.strictEqual(
    camera.cameraBelongsToTerminal(normal, { vehicle: '', project: 'CAR' }),
    false,
    '普通相机不能只靠项目匹配',
  )
  assert.strictEqual(
    camera.cameraBelongsToTerminal(spreader, { vehicle: 'PROJ-59', project: 'CAR' }),
    true,
    '吊具相机按项目跨车共用',
  )
  assert.strictEqual(
    camera.cameraBelongsToTerminal(spreader, { vehicle: '', project: 'PROJ' }),
    false,
  )
  assert.strictEqual(camera.cameraBelongsToTerminal(normal, { vehicle: '', project: '' }), false)
  assert.strictEqual(camera.cameraBelongsToTerminal(null, { vehicle: 'CAR-02' }), false)
})

check('SSH 命令反查保留书签 id 与分组，面板才能识别项目', () => {
  storage.clear()
  camera.reset()
  storage.set(
    'dsh-terminal-workbench.settings',
    JSON.stringify({
      bookmarkGroups: [
        { id: 'default', name: '默认分组' },
        { id: 'bg-twb-a', name: 'TWB项目A' },
      ],
      bookmarks: [],
    }),
  )
  const bookmark = {
    id: 'bm-twb-a',
    groupId: 'bg-twb-a',
    name: 'TWB-01',
    host: '192.168.60.5',
    port: 22,
    user: 'root',
    auth: 'agent',
  }
  const command = ssh.sshCommand(bookmark)
  const recovered = ssh.persistedSshBookmark(command)
  assert.ok(recovered, '命令应能反查到持久书签')
  assert.strictEqual(recovered.id, 'bm-twb-a')
  assert.strictEqual(recovered.groupId, 'bg-twb-a')
  const owner = camera.cameraOwnerForTerminalBookmark(recovered)
  assert.strictEqual(owner.vehicle, 'TWB-01')
  assert.strictEqual(owner.project, 'TWB项目A')
  storage.clear()
})

check('相机面板按当前终端分段显示', () => {
  assert.ok(code.indexOf("'当前终端 · '") >= 0, '面板应有当前终端分组')
  assert.ok(code.indexOf("'同一网段'") >= 0, '面板应保留同网段分组')
  assert.ok(code.indexOf("'其他相机书签'") >= 0, '无归属匹配时应明确标成其他书签')
  assert.ok(
    code.indexOf('cameraBelongsToTerminal(item, prefixInfo)') >= 0,
    '面板列表应调用归属判断',
  )
})

console.log(`\n== 相机书签：${passed}/${passed + failures.length} 通过`)
if (failures.length > 0) process.exitCode = 1
