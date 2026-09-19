// MCP protocol smoke test: drive the server exactly the way a real MCP client does
// (line-delimited JSON-RPC over stdio) and assert each stage of the handshake.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.js')

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ZH_PROMPT_DEBUG: '1' },
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})

const pending = new Map()
let nextId = 1
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
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
      console.log('!! 非 JSON 输出（会污染协议流）:', line.slice(0, 160))
      continue
    }
    const resolver = pending.get(message.id)
    if (resolver) {
      pending.delete(message.id)
      resolver(message)
    } else {
      console.log('!! 收到无人认领的消息:', JSON.stringify(message).slice(0, 160))
    }
  }
})

function request(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(method + ' 超时')), 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.stdin.write(JSON.stringify(payload) + '\n')
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function ok(condition, label, detail) {
  console.log(`${condition ? '  ✅' : '  ❌'} ${label}${detail ? '  → ' + detail : ''}`)
  return condition
}

let failures = 0
function check(condition, label, detail) {
  if (!ok(condition, label, detail)) failures += 1
}

try {
  console.log('=== 1) initialize ===')
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  })
  check(init.result !== undefined, '返回 result', JSON.stringify(init.result && init.result.protocolVersion))
  check(
    init.result && init.result.capabilities && init.result.capabilities.tools !== undefined,
    '声明了 tools 能力',
  )
  check(init.result && init.result.serverInfo && init.result.serverInfo.name === 'zh-prompt-search', 'serverInfo 正确', init.result && JSON.stringify(init.result.serverInfo))
  check(init.result && init.result.protocolVersion === '2025-06-18', '协议版本回显客户端请求值')

  notify('notifications/initialized')
  await new Promise((r) => setTimeout(r, 150))

  console.log('\n=== 2) tools/list ===')
  const list = await request('tools/list', {})
  const tools = (list.result && list.result.tools) || []
  check(tools.length > 0, '返回工具清单', tools.length + ' 个')
  for (const tool of tools) {
    const schemaOk = tool.inputSchema && tool.inputSchema.type === 'object' && tool.inputSchema.properties
    check(tool.name && tool.description && schemaOk, `工具 ${tool.name} 结构完整`)
  }

  console.log('\n=== 3) tools/call: 真实中文需求 ===')
  const call = await request('tools/call', {
    name: 'search_chinese_prompts',
    arguments: { query: '帮我分析一下水厂进水COD升高的原因', limit: 3 },
  })
  const content = call.result && call.result.content
  const text = Array.isArray(content) && content[0] ? content[0].text : ''
  check(Array.isArray(content) && content[0] && content[0].type === 'text', 'content 是 text 数组')
  check(text.length > 100, '返回了实质内容', text.length + ' 字符')
  check(/专家文档|提示词样例|任务骨架/.test(text), '含来源标签')
  console.log('  ── 返回片段预览 ──')
  console.log(
    text
      .split('\n')
      .slice(0, 8)
      .map((l) => '    ' + l.slice(0, 100))
      .join('\n'),
  )

  console.log('\n=== 4) tools/call: 取回全文 ===')
  const idMatch = text.match(/【(s\d+)/)
  check(idMatch !== null, '结果里带可引用的 id', idMatch ? idMatch[1] : '无')
  if (idMatch) {
    const doc = await request('tools/call', {
      name: 'get_chinese_prompt_doc',
      arguments: { id: idMatch[1] },
    })
    const docText = doc.result && doc.result.content && doc.result.content[0] && doc.result.content[0].text
    check(Boolean(docText), '取回全文成功', (docText || '').length + ' 字符')
  }

  console.log('\n=== 5) 边界：空 query / 未知工具 / 未知方法 ===')
  const empty = await request('tools/call', { name: 'search_chinese_prompts', arguments: { query: '  ' } })
  check(empty.result && empty.result.isError === true, '空 query 返回 isError')

  const unknownTool = await request('tools/call', { name: 'nope', arguments: {} })
  check(unknownTool.result && unknownTool.result.isError === true, '未知工具返回 isError')

  const unknownMethod = await request('resources/list', {})
  check(unknownMethod.error && unknownMethod.error.code === -32601, '未知方法返回 -32601')

  console.log('\n=== 6) 英文需求（应能命中或明确说明未命中）===')
  const en = await request('tools/call', {
    name: 'search_chinese_prompts',
    arguments: { query: 'review my React code for performance problems' },
  })
  const enText = en.result && en.result.content && en.result.content[0] && en.result.content[0].text
  check(Boolean(enText), '英文查询有响应', (enText || '').slice(0, 80))
} catch (error) {
  failures += 1
  console.log('\n❌ 测试异常：' + String(error.message || error))
} finally {
  child.stdin.end()
  await new Promise((r) => setTimeout(r, 300))
  child.kill()

  console.log('\n=== server stderr（诊断信息，不应污染 stdout） ===')
  console.log(
    stderr
      .split('\n')
      .filter(Boolean)
      .slice(0, 8)
      .map((l) => '  ' + l.slice(0, 140))
      .join('\n') || '  (空)',
  )
  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`))
  process.exit(failures === 0 ? 0 : 1)
}
