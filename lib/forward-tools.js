/**
 * dsh-terminal-workbench —— SSH 隧道工具（v0.8.0）。
 *
 * 三个工具：
 *   - `forward_open`   开一条隧道（需审批）
 *   - `forward_close`  关闭指定隧道（免审批：只会减少影响面）
 *   - `forward_list`   列出当前隧道（只读）
 *
 * 审批为什么放在 `tools/pre-execute` 而不是工具内部：dsh 的审批是
 * 运行时服务（`ctx.get('approval')`），工具执行时无法自己弹面板。
 * 在 pre-execute 里返回 `{ kind: 'ask' }`，运行时才会走审批链路。
 *
 * `approval=never`（danger-full-access）时运行时会把所有 ask 直接拒绝，
 * 面板根本不会出现；这里提前读策略，给出一句能照做的说明，而不是让
 * 模型收到莫名的 rejected。
 *
 * @module dsh-terminal-workbench/forward-tools
 */

import { MAX_FORWARDS, MAX_CHAIN } from './forward.js'
import { approvalPolicyOf, askOrDeny } from './approval-policy.js'

export const name = 'f-dsh-terminal-workbench-forward'
export const inject = ['tools']

/** 需要审批的工具集合。 */
const APPROVAL_TOOLS = new Set(['forward_open'])

/** 把转发规格压成一行，审批面板上看得懂。 */
function describeOpen(args) {
  const alias = typeof args?.alias === 'string' ? args.alias : ''
  const type = String(args?.type ?? 'L').toUpperCase()
  const bind = typeof args?.bind === 'string' ? args.bind : '127.0.0.1:0'
  const dest = typeof args?.dest === 'string' ? args.dest : ''
  if (type === 'D') return `SOCKS5 ${bind}（经 ${alias}）`
  return `${type} ${bind} → ${dest}（经 ${alias}）`
}

/**
 * @param {any} ctx
 * @param {{ manager: import('./forward.js').ForwardManager }} opts
 */
export function apply(ctx, opts) {
  const manager = opts.manager

  /* ---------- 审批闸门 ---------- */
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!APPROVAL_TOOLS.has(exec.name)) return next()
        const policy = approvalPolicyOf(ctx, exec.agent)
        const summary = describeOpen(exec.arguments)
        /* never 必须在最前面：确定性拒绝不能被后续逻辑绕过。 */
        return askOrDeny({
          policy,
          neverReason:
            'forward_open 需要主人审批，但当前会话的审批策略是 never（danger-full-access），审批面板不会出现。' +
            '请主人先用 /permission 切到一个 approval=ask 的预设（会同时改变文件沙箱），或新建一个允许审批的会话后重试；' +
            '也可以直接在终端里手动执行 ssh -L/-R/-D。',
          reason: `terminal-workbench: forward_open ${summary}`,
          displayReason: {
            en: `The agent wants to open an SSH tunnel: ${summary}. Allow this once?`,
            zh: `模型要开一条 SSH 隧道：${summary}。允许这一次吗？`,
          },
        })
      }),
    'terminal-workbench: forward approval gate',
  )

  /* ---------- forward_list（只读） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'forward_list',
        description:
          '列出当前生效的 SSH 隧道（转发 id、类型、绑定地址、目标、经过的跳板链）。只读、免审批。关闭隧道用 forward_close。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: { count: { type: 'number' }, text: { type: 'string' } },
            required: ['count', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
        },
        async execute() {
          const list = manager.list()
          if (list.length === 0) return { count: 0, text: '当前没有生效的 SSH 隧道。' }
          const lines = list.map(
            (item) =>
              `${item.id}｜${item.type === 'D' ? 'SOCKS5' : item.type}｜${item.bind} → ${item.dest}｜链路 ${item.chain}`,
          )
          return { count: list.length, text: `当前 ${list.length} 条隧道（上限 ${MAX_FORWARDS}）：\n${lines.join('\n')}` }
        },
      }),
    'terminal-workbench: tool forward_list',
  )

  /* ---------- forward_open（需审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'forward_open',
        description:
          '开一条 SSH 隧道，经 remotes.json 里配置的远端（可自动串联 jumpHost 跳板）。' +
          'type=L 本地端口转发（bind 本机监听地址，dest 远端可达的 host:port）；' +
          'type=R 远端端口转发（bind 远端监听地址，dest 本机可达的 host:port）；' +
          'type=D 本地 SOCKS5（只支持 CONNECT、无认证）。bind 省略时用 127.0.0.1:0（系统分配端口）。' +
          '需要主人审批；当前会话审批策略为 never 时会被拒绝并提示如何切换。',
        parameters: {
          type: 'object',
          properties: {
            alias: { type: 'string', description: 'remotes.json 中的远端别名（隧道末跳）' },
            type: { type: 'string', enum: ['L', 'R', 'D'], description: '转发类型：L 本地、R 远端、D SOCKS5' },
            bind: {
              type: 'string',
              description: '监听地址，写法 host:port 或直接写端口；端口 0 表示由系统分配。省略默认 127.0.0.1:0',
            },
            dest: { type: 'string', description: '目标地址 host:port；type=D 时不需要' },
            chain: {
              type: 'array',
              items: { type: 'string' },
              description: `可选：显式指定完整链路（最外层跳板→目标，最多 ${MAX_CHAIN} 跳）。省略时按 alias 的 jumpHost 自动解析。`,
            },
          },
          required: ['alias'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              bind: { type: 'string' },
              dest: { type: 'string' },
              chain: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['id', 'type', 'bind', 'dest', 'chain', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
        },
        async execute(args) {
          const summary = await manager.open(args)
          return {
            ...summary,
            text:
              `隧道已建立：${summary.id}\n` +
              `类型：${summary.type === 'D' ? 'SOCKS5' : summary.type}\n` +
              `监听：${summary.bind}\n` +
              `目标：${summary.dest}\n` +
              `链路：${summary.chain}\n` +
              `不再需要时用 forward_close ${summary.id} 关闭。`,
          }
        },
      }),
    'terminal-workbench: tool forward_open',
  )

  /* ---------- forward_close（免审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'forward_close',
        description: '关闭一条 SSH 隧道并释放监听端口。免审批（只会减少影响面）。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'forward_open / forward_list 返回的隧道 id' } },
          required: ['id'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
        },
        async execute(args) {
          const result = await manager.close(args.id)
          return { text: `隧道 ${result.id} 已关闭，监听端口已释放。` }
        },
      }),
    'terminal-workbench: tool forward_close',
  )
}
