/**
 * dsh-terminal-workbench —— 会话审批策略的单一实现。
 *
 * 为什么单独成模块：终端、SSH 隧道、远端文件三个工具模块都要在
 * `tools/pre-execute` 里判断 `approval=never`。三份复制最容易在新增破坏性
 * 工具时漏掉 never 分支，或者把“确定性拒绝”写成可被后续授权绕过的路径。
 *
 * 约定：
 * - `approvalPolicyOf` 只读，不改变任何状态；读不到返回 `undefined`，交给运行时兜底。
 * - `denyForNever` 是唯一判定 never 的地方；调用方必须在使用授权/ask 之前调用。
 * - `askForApproval` 只统一 ask 的结果形状，文案仍由各工具提供。
 *
 * @module dsh-terminal-workbench/approval-policy
 */

/**
 * 当前会话的审批策略。`danger-full-access` 预设会把它钉成 `never`，
 * 此时 dsh 的 `approval.decide()` 对任何 ask 都直接拒绝，面板不会出现。
 * @param {any} ctx - 插件上下文
 * @param {any} agent - 发起调用的 agent（策略按 session 折叠）
 * @returns {'ask' | 'never' | undefined} 读不到时返回 undefined
 */
export function approvalPolicyOf(ctx, agent) {
  try {
    const approval = ctx?.get?.('approval')
    if (approval !== undefined && agent?.session !== undefined) return approval.effectivePolicy(agent.session)
  } catch {
    /* 审批服务缺席或版本差异：读不到就走默认路径，让 dsh 自己判 */
  }
  return undefined
}

/**
 * 策略为 never 时生成确定性拒绝；其他情况返回 undefined。
 * 调用方必须先调用它，再判断已有授权或返回 ask，避免 never 被绕过。
 * @param {'ask' | 'never' | undefined} policy
 * @param {string} reason
 * @returns {{ kind: 'deny', reason: string } | undefined}
 */
export function denyForNever(policy, reason) {
  if (policy !== 'never') return undefined
  return { kind: 'deny', reason }
}

/**
 * 统一 ask 结果形状；文案由各工具提供。
 * @param {string} reason
 * @param {{ en: string, zh: string }} displayReason
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, zh: string } }}
 */
export function askForApproval(reason, displayReason) {
  return { kind: 'ask', reason, displayReason }
}

/**
 * 简单闸门的组合：never → deny，其余 → ask。
 * 需要先处理已有授权的工具（如终端）应分别调用 `denyForNever` / `askForApproval`。
 * @param {{
 *   policy: 'ask' | 'never' | undefined,
 *   neverReason: string,
 *   reason: string,
 *   displayReason: { en: string, zh: string },
 * }} options
 */
export function askOrDeny(options) {
  return denyForNever(options.policy, options.neverReason) ?? askForApproval(options.reason, options.displayReason)
}
