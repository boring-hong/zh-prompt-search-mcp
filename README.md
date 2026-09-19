# zh-prompt-search-mcp

> MCP server：**中文垂直语料检索**。给任何支持 MCP 的 agent（Claude Code / Codex / Cursor / DSH…）
> 提供中文参考材料 —— 中文专家文档、中文提示词样例、任务骨架。

## 它解决什么问题

让 agent 写中文提示词时，它通常只能靠模型自身的泛化能力。这个 server 让它在动笔前**先检索到
真正对口的中文参考材料**：

```
检索「帮我分析一下水厂进水COD升高的原因」
  → 【专家文档｜相关度 5.2】boujoy-expert-waterplant.md
     你是资深水厂工艺主管……按"先排除仪表与采样 → 再查管网外来水 → 再查厂内回流与工艺自身"
     的证据链顺序排查；处置按 0-2h 即时止损、2h-72h 中期调整、长期整改三级给出；
     数据不足处标注"需核实"，不得臆造数值。
```

那串证据链顺序与三级处置节奏**不是模型自己会想到的**，是语料带进去的。

## 两个工具

| 工具 | 作用 |
|---|---|
| `search_chinese_prompts` | 按需求检索参考材料。入参 `query`（中文为佳）、`limit`（默认 4，最大 8）。返回带来源标签与相关度的片段 |
| `get_chinese_prompt_doc` | 用上一步结果里的 `id` 取回该片段完整正文 |

### 语料构成

| 来源 | 内容 | 标签 |
|---|---|---|
| 中文专家文档 | 从 `skillsDir` 读取的 `*.md`（中文 ≥500 字才索引），命中后**整篇返回** | `专家文档` |
| 中文提示词样例 | 随包 379 条中文角色提示词 | `提示词样例` |
| 任务骨架 | 24 类任务模板骨架（对联 / 翻译 / 程序 / 商品文案…） | `任务骨架` |

**中文专有词保护**：`React`、`COD`、`MBR`、`AAOA` 这类词被切成二字组就再也匹配不上，
所以分词器规定**字母数字串整体保留**，中文串才产 2-gram。

```
输入: 帮我看看这段 React 代码有没有性能问题，水厂进水COD升高
分词: 帮我 我看 看看 看这 这段 react 代码 码有 有没 有性 性能 能问 问题 水厂 厂进 进水 cod 升高
                    ^^^^^ 整词                                          ^^^ 整词
```

## 安装

### Claude Code

```sh
claude mcp add zh-prompts -- node /绝对路径/zh-prompt-search/server.js
```

或写进项目/用户配置（`.mcp.json`）：

```json
{
  "mcpServers": {
    "zh-prompts": {
      "command": "node",
      "args": ["/绝对路径/zh-prompt-search/server.js"],
      "env": {
        "ZH_PROMPT_SKILLS": "/你的/专家文档目录"
      }
    }
  }
}
```

### Codex / 其他 MCP 宿主

同样填 `command: node`、`args: ["<绝对路径>/server.js"]`。协议是标准 stdio JSON-RPC，
不依赖任何宿主专有 API。

### DSH

```yaml
- id: mcp-zh-prompts
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: zh-prompts
    transport: stdio
    command: node
    args: ['<绝对路径>/server.js']
```

装好后模型会看到工具 `mcp__zh-prompts__search_chinese_prompts`。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ZH_PROMPT_SKILLS` | `~/.dsh/skills` | **你自己的专家文档目录**。这是检索质量的关键 —— 把领域文档放进去，命中就整篇注入 |
| `ZH_PROMPT_CORPUS` | `./zh-corpus.json` | 语料索引路径 |
| `ZH_PROMPT_DEBUG` | 关 | 设 `1` 把诊断信息写到 stderr（stdout 只走协议） |

`ZH_PROMPT_SKILLS` 不存在时**不会报错**，只是少一层来源 —— 仍能用随包的 379 条样例 + 24 类骨架。

## 验证

```sh
node test-mcp.mjs      # 或 npm test
```

跑完整的 MCP 握手：`initialize` → `tools/list` → 真实中文需求 `tools/call` → 取全文 →
边界用例（空 query / 未知工具 / 未知方法）。全绿才说明协议与检索都正常。

## 开发

```sh
node sync-corpus.mjs                  # 从插件仓库拉取最新语料与检索模块
node sync-corpus.mjs --local <目录>    # 或从本地插件目录拉取
```

`zhretriever.js` 与 `zh-corpus.json` 是**从 [dsh-zh-prompt-library](https://github.com/boring-hong/dsh-zh-prompt-library)
同步过来的 vendored 产物** —— 独立安装就不能依赖插件恰好装在某个路径，代价是两份副本，
所以用 `sync-corpus.mjs` 保证不漂移（脚本会在文件头写入来源与 sha256）。

## 许可

MIT。随包语料来自 [prompts.chat](https://prompts.chat) 与
[YeungNLP/firefly-train-1.1M](https://huggingface.co/datasets/YeungNLP/firefly-train-1.1M)，
请同时遵守其各自许可。
