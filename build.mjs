/**
 * 渲染 chunk 构建脚本：把 src/terminal.js 与 xterm/addons 打成零外部依赖的
 * client.terminal.js（模块加载器 chunk 格式）。
 *
 * 用法：node build.mjs
 *
 * 缓存破除：DSH 的 chunk URL 形如 client.terminal.js?rev=<入口 client.js 的元数据哈希>，
 * 只改 chunk 不改入口时 rev 不变，浏览器会一直吃 immutable 缓存。
 * 因此这里把 chunk 内容哈希写成入口文件末尾的注释标记，保证每次 chunk 变化
 * 都会让入口重新计算 rev。标记未变化时不重写文件，避免无谓的缓存失效。
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import crypto from 'node:crypto'

const result = await build({
  entryPoints: ['src/terminal.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  external: ['react'],
  loader: { '.css': 'text' },
  write: false,
})

const code = result.outputFiles[0].text
const wrapper = [
  '/* dsh-terminal-workbench 渲染 chunk：esbuild 产物 + __ModuleLoader__ 包装，请勿手改（改 src/terminal.js 后重跑 build.mjs） */',
  'window.__ModuleLoader__.load({',
  '  id: "dsh-terminal-workbench",',
  '  chunk: "client.terminal.js",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  code,
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

fs.writeFileSync('client.terminal.js', wrapper)
const chunkBytes = fs.readFileSync('client.terminal.js')

/* 把 chunk 哈希写入入口，驱动 DSH 重新计算 rev（缓存破除）。 */
const chunkRev = crypto.createHash('sha256').update(chunkBytes).digest('hex').slice(0, 12)
const entryPath = 'client.js'
const entry = fs.readFileSync(entryPath, 'utf8')
const marker = /\/\* chunk-rev: [^\n]*?\*\/\s*$/
const trimmed = entry.replace(/\s+$/, '')
const next = marker.test(trimmed)
  ? `${trimmed.replace(marker, `/* chunk-rev: ${chunkRev} */`)}\n`
  : `${trimmed}\n/* chunk-rev: ${chunkRev} */\n`
if (next !== entry) fs.writeFileSync(entryPath, next)

console.log('built client.terminal.js:', chunkBytes.length, 'bytes; chunk-rev:', chunkRev)
