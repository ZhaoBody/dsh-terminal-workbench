/**
 * dsh-terminal-workbench —— 远端文件工具（v0.8.0）。
 *
 * 内置 fs 工具（read/write/edit/list）已经覆盖远端读写：路径写
 * `remote:别名:/绝对/路径` 就会路由到远端。这里只补内置工具没有的能力：
 *
 *   - `remote_fs_list`    列出别名（只读）
 *   - `remote_fs_mkdir`   建目录（递归、幂等）
 *   - `remote_fs_move`    同机移动/改名
 *   - `remote_fs_copy`    同机复制 / 跨机直传（SFTP 流直连，不落本地磁盘）
 *   - `remote_fs_remove`  删除（**必须审批**，递归要显式）
 *
 * 为什么不再造一套 read/write：重复工具体只会让模型在「用哪个」上浪费
 * token，而且两条路径的版本守卫、大小闸门很难保持一致。
 *
 * @module dsh-terminal-workbench/remote-fs-tools
 */

import { PATH_RE, readRemotes } from './remote-fs.js'
import { approvalPolicyOf, askOrDeny } from './approval-policy.js'

export const name = 'f-dsh-terminal-workbench-remote-fs'
export const inject = ['tools']

/** 需要审批的工具集合。 */
const APPROVAL_TOOLS = new Set(['remote_fs_remove'])

/** 解析并校验 `remote:别名:/路径`，同时确认别名已配置。 */
function addressOf(opts, raw, label) {
  const text = String(raw ?? '').trim()
  const match = PATH_RE.exec(text)
  if (match === null) {
    throw new Error(`${label}要写成 remote:别名:/绝对/路径，收到：${raw}`)
  }
  const alias = match[1]
  const known = opts.remoteFs.aliases()
  if (known.indexOf(alias) === -1) {
    throw new Error(`${label}里的远端「${alias}」未配置；已配置：${known.length === 0 ? '（空）' : known.join('、')}`)
  }
  return { alias, path: match[2] }
}

/** 审批面板上看得懂的一行摘要。 */
function describeRemove(args) {
  const path = typeof args?.path === 'string' ? args.path : ''
  const recursive = args?.recursive === true ? '（递归）' : ''
  return `删除 ${path}${recursive}`
}

/**
 * @param {any} ctx
 * @param {{
 *   remotesFile: string,
 *   probe: (alias: string) => Promise<string>,
 *   remoteFs: {
 *     backendOf: (alias: string) => any,
 *     copyBetween: (from: string, to: string) => Promise<any>,
 *     aliases: () => string[],
 *   },
 * }} opts
 */
export function apply(ctx, opts) {
  /* ---------- 删除审批闸门 ---------- */
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!APPROVAL_TOOLS.has(exec.name)) return next()
        const policy = approvalPolicyOf(ctx, exec.agent)
        const summary = describeRemove(exec.arguments)
        /* never 必须在最前面：确定性拒绝不能被后续逻辑绕过。 */
        return askOrDeny({
          policy,
          neverReason:
            'remote_fs_remove 需要主人审批，但当前会话的审批策略是 never（danger-full-access），审批面板不会出现。' +
            '请主人先用 /permission 切到一个 approval=ask 的预设（会同时改变文件沙箱），或直接在文件面板里删除；' +
            '也可以改用终端命令手动删除。',
          reason: `terminal-workbench: remote_fs_remove ${summary}`,
          displayReason: {
            en: `The agent wants to permanently delete ${summary}. Allow this once?`,
            zh: `模型要永久删除 ${summary}。允许这一次吗？`,
          },
        })
      }),
    'terminal-workbench: remote remove approval gate',
  )

  /* ---------- remote_fs_list（只读） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'remote_fs_list',
        description:
          '列出已配置的 SSH 远端（别名、地址、认证方式、跳板、当前连接状态）。要对远端读写文件时，在 read/write/edit/list 等文件工具的路径里写 remote:别名:/绝对/路径（例如 remote:vps:/etc/nginx/nginx.conf），就会走这台远端；本工具只用来确认有哪些别名、连不连得通，不需要审批。',
        parameters: {
          type: 'object',
          properties: {
            probe: {
              type: 'boolean',
              description: '可选：为 true 时对每个远端做一次真实连接探测（会发起 SSH 握手，可能要几秒）；不传或 false 只读配置，不连接。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              remotes: { type: 'string' },
            },
            required: ['count', 'remotes'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: 'text', text: `已配置 ${value?.count ?? 0} 个远端\n${value?.remotes ?? ''}` },
          ],
        },
        async execute(args) {
          const remotes =
            typeof opts.remoteFs.entries === 'function'
              ? opts.remoteFs.entries()
              : readRemotes(opts.remotesFile)
          const aliases = Object.keys(remotes)
          if (aliases.length === 0) {
            return {
              count: 0,
              remotes: `（清单为空：在 ${opts.remotesFile} 里按 {"别名": {"host": "…", "username": "…", "auth": "key", "keyPath": "~/.ssh/id_rsa"}} 配置；或在终端里用 SSH 书签打开会话后，文件面板会自动登记该连接）`,
            }
          }
          const lines = []
          for (const alias of aliases) {
            const entry = remotes[alias]
            const auth = entry.auth === 'password' ? '密码' : `私钥 ${entry.keyPath ?? '~/.ssh/id_rsa'}`
            let line = `${alias}｜${entry.username}@${entry.host}:${entry.port ?? 22}｜${auth}`
            const jump = entry.jumpHost ?? entry.jump ?? entry.proxyJump
            if (typeof jump === 'string' && jump.trim() !== '') line += `｜经跳板 ${jump.trim()}`
            if (args?.probe === true) {
              line += `｜${await opts.probe(alias)}`
            }
            lines.push(line)
          }
          return { count: aliases.length, remotes: lines.join('\n') }
        },
      }),
    'terminal-workbench: tool remote_fs_list',
  )

  /* ---------- remote_fs_mkdir（免审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'remote_fs_mkdir',
        description:
          '在 SSH 远端创建目录。remote:别名:/绝对/路径。已存在且是目录时直接成功（幂等）；recursive=true 时逐级创建父目录。免审批。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'remote:别名:/绝对/路径' },
            recursive: { type: 'boolean', description: '可选：为 true 时逐级创建缺失的父目录' },
          },
          required: ['path'],
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
          const address = addressOf(opts, args.path, 'path')
          const result = await opts.remoteFs.backendOf(address.alias).mkdir(address.path, {
            recursive: args?.recursive === true,
          })
          return {
            text: result.created
              ? `已创建目录：remote:${address.alias}:${result.path}`
              : `目录已存在，无需创建：remote:${address.alias}:${result.path}`,
          }
        },
      }),
    'terminal-workbench: tool remote_fs_mkdir',
  )

  /* ---------- remote_fs_move（免审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'remote_fs_move',
        description:
          '在同一个 SSH 远端内移动或重命名文件/目录（remote:别名:/路径）。跨远端移动不支持，请改用 remote_fs_copy（跨机直传）再删除源。免审批。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源：remote:别名:/绝对/路径' },
            to: { type: 'string', description: '目标：remote:别名:/绝对/路径（必须与源同别名）' },
          },
          required: ['from', 'to'],
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
          const from = addressOf(opts, args.from, 'from')
          const to = addressOf(opts, args.to, 'to')
          if (from.alias !== to.alias) {
            throw new Error(
              `remote_fs_move 只支持同机移动（源 ${from.alias}、目标 ${to.alias}）。跨机请先用 remote_fs_copy 复制，再按需 remote_fs_remove 删除源。`,
            )
          }
          const result = await opts.remoteFs.backendOf(from.alias).rename(from.path, to.path)
          return {
            text: result.noop
              ? `源与目标是同一路径，未做改动：remote:${from.alias}:${from.path}`
              : `已移动：remote:${from.alias}:${from.path} → remote:${to.alias}:${to.path}`,
          }
        },
      }),
    'terminal-workbench: tool remote_fs_move',
  )

  /* ---------- remote_fs_copy（免审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'remote_fs_copy',
        description:
          '复制远端文件/目录。同机走 SFTP 复制；跨机走两个 SFTP 流直连，不经过本地磁盘。目录递归复制；目标已存在的文件会被覆盖。免审批。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源：remote:别名:/绝对/路径' },
            to: { type: 'string', description: '目标：remote:别名:/绝对/路径' },
          },
          required: ['from', 'to'],
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
          const from = addressOf(opts, args.from, 'from')
          const to = addressOf(opts, args.to, 'to')
          const result =
            from.alias === to.alias
              ? await opts.remoteFs.backendOf(from.alias).copy(from.path, to.path)
              : await opts.remoteFs.copyBetween(args.from, args.to)
          if (result?.type === 'noop') {
            return { text: `源与目标是同一路径，未做改动：remote:${from.alias}:${from.path}` }
          }
          const route = from.alias === to.alias ? from.alias : `${from.alias} → ${to.alias}`
          return {
            text: `已复制${result?.type === 'directory' ? '目录' : '文件'}：remote:${from.alias}:${from.path} → remote:${to.alias}:${to.path}（${route}）`,
          }
        },
      }),
    'terminal-workbench: tool remote_fs_copy',
  )

  /* ---------- remote_fs_remove（需审批） ---------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'remote_fs_remove',
        description:
          '删除远端文件或目录（remote:别名:/路径）。不可逆，必须经主人审批。目录默认必须为空；递归删除必须显式 recursive=true。拒绝删除远端根目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'remote:别名:/绝对/路径' },
            recursive: { type: 'boolean', description: '可选：为 true 时递归删除非空目录' },
          },
          required: ['path'],
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
          const address = addressOf(opts, args.path, 'path')
          const result = await opts.remoteFs.backendOf(address.alias).remove(address.path, {
            recursive: args?.recursive === true,
          })
          return {
            text: `已删除${result.type === 'directory' ? '目录' : '文件'}：remote:${address.alias}:${result.path}`,
          }
        },
      }),
    'terminal-workbench: tool remote_fs_remove',
  )
}
