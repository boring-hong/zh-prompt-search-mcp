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
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = 'boring-hong/dsh-zh-prompt-library'
const REF = process.argv.includes('--ref')
  ? process.argv[process.argv.indexOf('--ref') + 1]
  : 'main'

const localIdx = process.argv.indexOf('--local')
const LOCAL_DIR = localIdx !== -1 ? process.argv[localIdx + 1] : null

const FILES = [
  { name: 'zhretriever.js', remote: 'lib/zhretriever.js', local: 'lib/zhretriever.js' },
  { name: 'zh-corpus.json', remote: 'lib/zh-corpus.json', local: 'lib/zh-corpus.json' },
]

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
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
for (const file of FILES) {
  const { text, origin } = await fetchText(file)
  const target = join(HERE, file.name)
  let previous = null
  try {
    previous = await readFile(target, 'utf8')
  } catch (error) {
    previous = null
  }
  if (previous === text) {
    console.log(`  = ${file.name} 未变化（sha256:${sha256(text)}）`)
    continue
  }
  // 在文件头写入来源与校验值，便于日后核对两份副本是否漂移。
  const header =
    file.name.endsWith('.json')
      ? null
      : `// vendored from ${origin}\n// sha256:${sha256(text)}  synced:${new Date().toISOString()}\n`
  await writeFile(target, header ? header + text : text)
  console.log(`  ✎ ${file.name} 已更新（sha256:${sha256(text)}）`)
  changed += 1
}

console.log(changed === 0 ? '\n全部已是最新。' : `\n更新了 ${changed} 个文件。`)
if (!LOCAL_DIR) {
  console.log('提示：语料来自 ' + REPO + '@' + REF + '，改完记得跑 `npm test` 验证协议与检索。')
}
