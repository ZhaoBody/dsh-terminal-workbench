/** 日志根目录句柄的浏览器持久化；错误交给调用方展示，连接始终释放。 */
const DB_NAME = 'dsh-terminal-workbench-fs'
const STORE = 'handles'
const KEY = 'log-directory'

function openDatabase(provider) {
  return new Promise((resolve, reject) => {
    if (!provider) { reject(new Error('浏览器不支持记住日志目录')); return }
    const request = provider.open(DB_NAME, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onblocked = () => {
      blocked = true
      reject(new Error('日志目录存储被其他窗口占用，请关闭旧窗口后重试'))
    }
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('日志目录存储打开失败'))
  })
}

export async function loadLogDirectory(provider = globalThis.indexedDB) {
  const db = await openDatabase(provider)
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(KEY)
      let handle
      request.onsuccess = () => { handle = request.result }
      transaction.oncomplete = () => resolve(typeof handle?.getDirectoryHandle === 'function' ? handle : undefined)
      transaction.onerror = () => reject(transaction.error ?? new Error('读取日志目录失败'))
      transaction.onabort = () => reject(transaction.error ?? new Error('读取日志目录已中止'))
    })
  } finally {
    db.close()
  }
}

export async function saveLogDirectory(handle, provider = globalThis.indexedDB) {
  const db = await openDatabase(provider)
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(handle, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('记住日志目录失败'))
      transaction.onabort = () => reject(transaction.error ?? new Error('记住日志目录已中止'))
    })
  } finally {
    db.close()
  }
}
