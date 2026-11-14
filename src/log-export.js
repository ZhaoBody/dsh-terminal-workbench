/** 终端日志导出：命名、内容校验和目录写入。 */
export function safeFilePart(value, fallback = 'terminal', maxBytes = 64) {
  const cleaned = String(value ?? '').normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '')
  /* 文件系统限制通常按字节计算；不能把 64 个中文字符当成 64 字节。 */
  let name = ''
  let bytes = 0
  for (const character of cleaned) {
    const code = character.codePointAt(0)
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) break
    name += character
    bytes += size
  }
  const safe = name.replace(/[.\s-]+$/g, '') || fallback
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? '_' + safe : safe
}

export function logLocation({ workspace, terminalName, now = new Date() }) {
  if (!workspace?.workspaceId || !String(workspace.title ?? '').trim()) {
    throw new Error('工作区信息尚未就绪，请稍后重试导出')
  }
  const title = safeFilePart(workspace.title, 'workspace')
  const id = safeFilePart(workspace.workspaceId, 'workspace-id', 128)
  const name = safeFilePart(terminalName)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '-' + pad(now.getMilliseconds(), 3)
  return { directory: title + '--' + id, fileName: title + '__' + name + '__' + stamp + '.log' }
}

/* 同页导出串行化：检查同名文件后再创建，避免不同终端同时导出互相覆盖。 */
let logQueue = Promise.resolve()
export function saveTerminalLog(root, options) {
  const pending = logQueue.then(() => writeTerminalLog(root, options))
  logQueue = pending.then(() => undefined, () => undefined)
  return pending
}

async function writeTerminalLog(root, options) {
  const location = logLocation(options)
  const folder = await root.getDirectoryHandle(location.directory, { create: true })
  const stem = location.fileName.slice(0, -4)
  let fileName
  for (let index = 0; index < 1000; index += 1) {
    const candidate = stem + (index === 0 ? '' : '--' + (index + 1)) + '.log'
    try {
      await folder.getFileHandle(candidate)
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
      fileName = candidate
      break
    }
  }
  if (fileName === undefined) throw new Error('同名日志过多，请稍后重试')
  const handle = await folder.getFileHandle(fileName, { create: true })
  let writable
  try {
    writable = await handle.createWritable()
    await writable.write(options.text)
    await writable.close()
  } catch (error) {
    const failures = [error]
    if (writable && typeof writable.abort === 'function') {
      try { await writable.abort() } catch (abortError) { failures.push(abortError) }
    }
    try { await folder.removeEntry(fileName) } catch (cleanupError) { failures.push(cleanupError) }
    if (failures.length > 1) throw new AggregateError(failures, '日志保存失败，且临时文件未能完全清理')
    throw error
  }
  return { ...location, fileName, path: root.name + '/' + location.directory + '/' + fileName }
}

/** 只排除全空及明确的常见 shell 提示符，不按 $/#/> 后缀误删实际输出。 */
export function hasExportableContent(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean)
  const isPrompt = line => /^[$#>]$/.test(line) ||
    /^(?:\([^\n)]+\)\s*)?[\w.-]+@[\w.-]+:[^\n]*[$#]\s*$/.test(line) ||
    /^\[[^\]\n]+@[^\]\n]+\s[^\]\n]+\][$#]\s*$/.test(line) ||
    /^[\w.-]+:(?:~|\/)[^\n]*[$#]\s*$/.test(line) ||
    /^(?:PS\s+)?[A-Za-z]:\\[^\n]*>\s*$/.test(line)
  return lines.some(line => !isPrompt(line))
}
