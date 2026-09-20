#!/usr/bin/env node
// 从 DSH 插件仓库同步 vendored 产物（检索模块 + 语料索引）。
//
// 为什么是「同步」而不是运行时读：MCP server 要能被任何宿主独立安装，不能依赖
// DSH 插件恰好装在某个路径。代价是语料会有两份副本 —— 所以用这个脚本保证它们不漂移，
// 并在文件头写入来源与校验值。
//
// 用法：
//   node sync-corpus.mjs                 # 默认从 GitHub 拉取
//   node sync-corpus.mjs --local <dir>   # 从本地插件目录拉取（开发期更快）
//   node sync-corpus.mjs --force         # 目标有本地改动时也覆盖
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = 'boring-hong/dsh-zh-prompt-library'
const REF = process.argv.includes('--ref')
  ? process.argv[process.argv.indexOf('--ref') + 1]
  : 'main'
const FORCE = process.argv.includes('--force')

const localIdx = process.argv.indexOf('--local')
const LOCAL_DIR = localIdx !== -1 ? process.argv[localIdx + 1] : null

const FILES = [
  { name: 'zhretriever.js', remote: 'lib/zhretriever.js', local: 'lib/zhretriever.js' },
  { name: 'zh-corpus.json', remote: 'lib/zh-corpus.json', local: 'lib/zh-corpus.json' },
]

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// The vendor header is added by this script, so it must also be removed before comparing —
// otherwise every run sees a "change" and appends another header on top of the last one.
function stripVendorHeader(text) {
  return text.replace(/^(?:\/\/ vendored from [^\n]*\n|\/\/ sha256:[^\n]*\n)+/, '')
}

function vendorHeader(origin, text) {
  return `// vendored from ${origin}\n// sha256:${sha256(text)}  synced:${new Date().toISOString()}\n`
}

async function fetchText(file) {
  if (LOCAL_DIR) {
    const path = join(LOCAL_DIR, file.local)
    const text = await readFile(path, 'utf8')
    return { text, origin: 'local:' + path }
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${file.remote}`
  const res = await fetch(url, { headers: { 'user-agent': 'zh-prompt-search-sync' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} 拉取失败：${url}`)
  return { text: await res.text(), origin: url }
}

let changed = 0
let blocked = 0
for (const file of FILES) {
  const { text, origin } = await fetchText(file)
  const target = join(HERE, file.name)
  let previous = null
  try {
    previous = await readFile(target, 'utf8')
  } catch (error) {
    previous = null
  }

  const previousBody = previous === null ? null : stripVendorHeader(previous)
  // Normalise the incoming text too: the plugin copy carries no vendor header while this copy
  // does, so comparing raw text would make the header itself look like content drift — every run
  // would report a conflict on a file that is actually identical.
  const incomingBody = stripVendorHeader(text)
  if (previousBody === incomingBody) {
    console.log(`  = ${file.name} 未变化（sha256:${sha256(incomingBody)}）`)
    continue
  }

  // A pre-existing copy that differs from upstream may carry deliberate local fixes (for example
  // the skills threshold and injection cap tuned in this repo). Overwriting it silently would
  // revert them, so require an explicit --force.
  if (previousBody !== null && !FORCE) {
    console.log(`  ! ${file.name} 与上游不一致（本地 ${sha256(previousBody)} ≠ 上游 ${sha256(incomingBody)}）`)
    console.log(`      未覆盖。确认要放弃本地改动请加 --force；若本地是修复，请先把它同步回 ${REPO}。`)
    blocked += 1
    continue
  }

  const header = file.name.endsWith('.json') ? null : vendorHeader(origin, incomingBody)
  await writeFile(target, header ? header + incomingBody : incomingBody)
  console.log(`  ✎ ${file.name} 已更新（sha256:${sha256(incomingBody)}）`)
  changed += 1
}

console.log(
  changed === 0 && blocked === 0
    ? '\n全部已是最新。'
    : `\n更新了 ${changed} 个文件。` + (blocked > 0 ? ` ${blocked} 个因本地改动被跳过。` : ''),
)
if (!LOCAL_DIR) {
  console.log('提示：语料来自 ' + REPO + '@' + REF + '，改完记得跑 `npm test` 验证协议与检索。')
}
