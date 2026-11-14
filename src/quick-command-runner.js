/** 可取消的快捷命令序列，只负责投递步骤，不解释 shell 执行结果。 */
function cancelled() {
  const error = new Error('后续快捷命令步骤已取消')
  error.name = 'AbortError'
  return error
}

export function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(cancelled())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 取消只阻止后续输入，不向已执行的 shell 命令发送 Ctrl+C。 */
export async function runQuickSteps({ item, write, resolveText, signal, isWritable, onStep = () => {}, delay = abortableDelay }) {
  const steps = Array.isArray(item.commands) ? item.commands : []
  const total = steps.length
  let step = 0
  try {
    if (total === 0) throw new Error('快捷命令没有可执行步骤')
    const ensureReady = () => {
      if (signal?.aborted) throw cancelled()
      if (!isWritable()) throw new Error('目标终端已隐藏、断开或不可写，已停止后续输入')
    }
    for (let index = 0; index < total; index += 1) {
      step = index + 1
      ensureReady()
      const text = await resolveText(steps[index].command ?? '')
      ensureReady()
      const enter = index < total - 1 || item.inputOnly !== true
      const input = String(text) + (enter ? '\r' : '')
      if (input !== '') await write(input)
      onStep({ step, total, text: String(text) })
      ensureReady()
      const milliseconds = Number(steps[index].delay)
      if (index < total - 1 && Number.isFinite(milliseconds) && milliseconds > 0) {
        await delay(milliseconds, signal)
      }
    }
    return { status: 'completed', step, total }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { status: 'cancelled', step, total }
    return { status: 'failed', step, total, message: error instanceof Error ? error.message : String(error) }
  }
}
