#!/usr/bin/env node
// dsh-zh-prompt-search — 把「中文垂直语料检索」包成 MCP server，供任何支持 MCP 的宿主使用
// （Claude Code / Codex / Cursor / DSH 自身…）。
//
// 为什么零依赖：MCP stdio 传输就是「一行一个 JSON-RPC 2.0 消息」，自己实现不到 200 行，
// 换来的好处是 `npx` 或 `node` 直接能跑，不受 Node 版本与包管理器差异影响。
//
// 协议：
//   initialize  → 回 capabilities.tools + serverInfo（协议版本跟随客户端请求，取交集）
//   notifications/initialized → 无需回复
//   tools/list  → 工具清单
//   tools/call  → 执行工具，回 content 数组
//
// 环境变量：
//   ZH_PROMPT_CORPUS           语料索引路径（默认 ./lib/zh-corpus.json）
//   ZH_PROMPT_SKILLS           本地专家文档目录（默认 ~/.dsh/skills；不存在则只用语料）
//   ZH_PROMPT_SKILLS_MIN_CJK   文档低于此汉字数视为占位文件而不检索（默认 150）
//   ZH_PROMPT_SKILLS_MAX_CHARS 单篇文档注入上限，超出则截断并标注（默认 8000）
//   ZH_PROMPT_DEBUG=1          把诊断信息写到 stderr（stdout 只允许协议消息）

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZhRetriever, SKILLS_MIN_CJK } from './zhretriever.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// Report the real package version rather than a literal, so serverInfo can never drift from
// package.json (it already had: 0.1.0 reported after the version was bumped).
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// 协议版本：按 MCP 规范，服务端应回客户端请求的版本；不认识则回自己支持的最新版。
// 客户端不匹配时会自行断开并报错，所以这里只做保守的取交集。
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL = '2024-11-05'

const DEBUG = process.env.ZH_PROMPT_DEBUG === '1'
function debug(...args) {
  if (DEBUG) process.stderr.write('[zh-prompt-search] ' + args.join(' ') + '\n')
}

function defaultSkillsDir() {
  const home = process.env.DSH_HOME
  if (home) return join(home, 'skills')
  const userHome = process.env.USERPROFILE || process.env.HOME
  return userHome ? join(userHome, '.dsh', 'skills') : ''
}

const CORPUS_PATH = process.env.ZH_PROMPT_CORPUS || join(HERE, 'zh-corpus.json')
const SKILLS_DIR = process.env.ZH_PROMPT_SKILLS || defaultSkillsDir()

const retriever = createZhRetriever({
  skillsDir: SKILLS_DIR,
  readFirst: async (name) => {
    const target = name === 'zh-corpus.json' ? CORPUS_PATH : join(HERE, name)
    return await readFile(target, 'utf8')
  },
})

const TOOLS = [
  {
    name: 'search_chinese_prompts',
    description:
      '从中文垂直语料检索与需求相关的参考材料（中文专家文档 / 中文提示词样例 / 任务骨架）。' +
      '写中文提示词、或需要中文专业表述与判断逻辑时，先调用它取参考，再据此撰写。' +
      '返回带来源标签的片段；命中中文专家文档（source=expert）时是完整正文，可作为该领域的权威参考。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '需求原文，中文为佳（如「分析水厂进水COD升高的原因」）' },
        limit: { type: 'integer', description: '返回片段数上限，默认 4，最大 8', minimum: 1, maximum: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_chinese_prompt_doc',
    description: '按 search_chinese_prompts 返回的 id 取回某条参考材料的完整正文。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'search_chinese_prompts 结果里给出的 id' } },
      required: ['id'],
    },
  },
]

// 最近一次检索的片段，按 id 缓存，供 get_chinese_prompt_doc 取回全文。
const snippetCache = new Map()
let snippetSeq = 0

function renderSnippets(result) {
  const lines = []
  lines.push(
    `命中 ${result.snippets.length} 条（语料：中文样例 ${result.stats.general} 条 + 任务骨架若干；本地专家文档 ${result.stats.skills} 个）`,
  )
  result.snippets.forEach((snippet) => {
    const id = 's' + (snippetSeq += 1)
    snippetCache.set(id, snippet)
    const kind = snippet.source === 'skill' ? '专家文档' : snippet.source === 'template' ? '任务骨架' : '提示词样例'
    lines.push('')
    lines.push(`【${id}｜${kind}｜相关度 ${Math.round(snippet.score * 10) / 10}】${snippet.label}`)
    lines.push(snippet.text)
  })
  if (snippetSeq > 200) {
    // 缓存无上限会随会话无限增长；这里简单裁掉最早的一半。
    const keys = [...snippetCache.keys()]
    for (const key of keys.slice(0, Math.floor(keys.length / 2))) snippetCache.delete(key)
  }
  return lines.join('\n')
}

async function callTool(name, args) {
  if (name === 'search_chinese_prompts') {
    const query = String((args && args.query) || '').trim()
    if (!query) return { isError: true, text: 'query 不能为空' }
    const limit = Math.min(8, Math.max(1, Number((args && args.limit) || 4)))
    const result = await retriever.retrieve(query, limit)
    if (result.snippets.length === 0) {
      return { text: `未命中相关中文参考材料（查询词 ${result.stats.terms} 个）。可自行撰写，或换个更具体的说法再试。` }
    }
    return { text: renderSnippets(result) }
  }

  if (name === 'get_chinese_prompt_doc') {
    const id = String((args && args.id) || '').trim()
    const snippet = snippetCache.get(id)
    if (!snippet) return { isError: true, text: `没有 id=${id} 的缓存片段，请先调用 search_chinese_prompts。` }
    // Skills are injected capped; this is the escape hatch that returns the untruncated original.
    return { text: `【${snippet.label}】\n\n${snippet.fullText || snippet.text}` }
  }

  return { isError: true, text: `未知工具：${name}` }
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────────
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  // 通知（无 id）不需要回复。
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    const requested = params && params.protocolVersion
    const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
    respond(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'zh-prompt-search', version: VERSION },
    })
    debug('initialize → protocol', version, 'client', JSON.stringify((params && params.clientInfo) || {}))
    return
  }

  if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) {
    return
  }

  if (method === 'ping') {
    respond(id, {})
    return
  }

  if (method === 'tools/list') {
    respond(id, { tools: TOOLS })
    return
  }

  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const outcome = await callTool(name, args)
      respond(id, {
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      })
    } catch (error) {
      respond(id, {
        content: [{ type: 'text', text: '检索失败：' + String((error && error.message) || error) }],
        isError: true,
      })
    }
    return
  }

  if (isNotification) return
  respondError(id, -32601, `Method not found: ${method}`)
}

// 逐行读 stdin。MCP stdio 是「一行一个 JSON 消息」，不支持跨行 JSON。
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      debug('忽略无法解析的行：', line.slice(0, 120))
      continue
    }
    handle(message).catch((error) => {
      debug('handle 抛出：', String((error && error.message) || error))
    })
  }
})

process.stdin.on('end', () => process.exit(0))

// 启动时预热并做一次自检，把结果写 stderr（不污染 stdout 的协议流）。
retriever
  .warmup()
  .then((info) => {
    debug('ready: docs=' + info.docs + ' general=' + info.general + ' skills=' + info.skills)
    if (info.skills === 0) {
      debug('提示：未找到本地专家文档目录（' + (SKILLS_DIR || '(未配置)') + '），仅使用随包语料。')
    }
    // Say which files were skipped and why, so a deliberately placed document never silently
    // fails to match.
    const skipped = Array.isArray(info.skipped) ? info.skipped : []
    if (skipped.length > 0) {
      debug(
        '提示：' + skipped.length + ' 个 .md 因过短未纳入检索（阈值 ' + SKILLS_MIN_CJK + ' 汉字，可用 ZH_PROMPT_SKILLS_MIN_CJK 调整）：' +
          skipped.map((s) => `${s.name}(${s.cjk})`).join('、'),
      )
    }
    if (!existsSync(CORPUS_PATH)) {
      debug('警告：语料文件不存在 ' + CORPUS_PATH + '，检索将返回空结果。')
    }
  })
  .catch((error) => debug('warmup 失败：' + String((error && error.message) || error)))
