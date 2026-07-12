# webtools

pi 的 web search / fetch 工具集。为 LLM 提供可操作的搜索结果和页面内容获取。

## 架构

```
webtools/
├── search.ts              # pi 工具注册：websearch
├── fetch.ts               # pi 工具注册：webfetch
├── format.ts              # 共享工具：raceWithAbort, applyTruncation
└── service/
    ├── index.ts           # 路由层：shuffle + 顺序回退
    ├── firecrawl.ts       # Firecrawl SDK（search + fetch）
    ├── exa.ts             # Exa SDK（search only）
    ├── gemini.ts          # Gemini API（search only）
    ├── jina.ts            # Jina Reader（fetch only）
    └── readability.ts     # 本地 Readability + Turndown（fetch only）
```

**原则**：`search.ts` / `fetch.ts` 只管工具注册和参数校验，业务逻辑委托给 service 层。新增 provider 只需加一个 `service/xxx.ts` 并在 `index.ts` 注册。

## 配置

配置文件路径：`~/.pi/agent/pix-config.jsonc`（支持 JSONC 注释和尾逗号）

```jsonc
{
  "firecrawl": { "apiKey": "fc-..." },
  "exa": { "apiKey": "..." },
  "gemini": {
    "apiKey": "AIza...",
    "searchModel": "gemini-2.5-flash"   // 可选，默认 gemini-2.5-flash
  },
  "jina": { "apiKey": "jina_..." }      // 可选，免费层 20/min 也够用
}
```

环境变量（优先级高于配置文件）：

| 变量 | 对应 provider |
|------|-------------|
| `FIRECRAWL_API_KEY` | Firecrawl |
| `EXA_API_KEY` | Exa |
| `GEMINI_API_KEY` | Gemini |
| `JINA_API_KEY` | Jina Reader（可选，免费层也够用） |

## 工具

### websearch

搜索 web 并返回结果列表。LLM 可根据结果调用 `webfetch` 获取全文。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✓ | 搜索关键词 |
| `limit` | integer | ✗ | 结果数量（默认 10，最大 100） |
| `includeDomains` | string[] | ✗ | 限定域名（如 `["react.dev"]`） |
| `excludeDomains` | string[] | ✗ | 排除域名（如 `["reddit.com"]`） |

`includeDomains` 和 `excludeDomains` 不能同时使用。

### webfetch

抓取单个 URL 并返回 markdown 内容。多 provider 顺序回退（Firecrawl → Jina Reader → 本地 Readability），零配置也能用。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✓ | 目标 URL |

**与 search 不同**：webfetch 的 Jina Reader 和本地 Readability 均无需 API key，
因此即使没配任何 provider 也能工作。配了 Firecrawl key 则自动获得更高质量的 headless browser 渲染。

### webfetch Provider 对比

| | Firecrawl | Jina Reader | 本地 Readability |
|---|---|---|---|
| **JS 渲染** | ✅ headless browser | ✅ headless browser | ❌ 纯静态 HTML |
| **需要 API key** | ✅ FIRECRAWL_API_KEY | ❌ 免费 | ❌ |
| **回退顺序** | ① 最前（有 key 时） | ② 中间 | ③ 最后兜底 |

## 搜索 Provider 对比

| | Firecrawl | Exa | Gemini |
|---|---|---|---|
| **search** | REST API（SDK） | REST API（SDK） | Gemini generateContent + google_search tool |
| **结果数量** | limit 参数 | numResults 参数 | 由 Gemini 决定（通常 5-10 条） |
| **超时** | 30s + 1 retry | 无显式超时（SDK 内置） | 60s（Gemini API） |
| **模型** | — | — | `gemini-2.5-flash`（可配 `searchModel`） |

## Search Provider 选择与回退

```
shuffle(firecrawl, exa)  →  逐个尝试  →  首个成功返回
       ↓ 全失败
     gemini（成本最高，固定末尾）
       ↓ 失败
     汇总所有错误，抛错
```

- firecrawl + exa 随机排列：分散负载，避免单一 provider 限流
- gemini 固定在最后：Gemini API 按 token 计费，成本高于专用搜索 API
- 至少需要一个已配置 API key 的 provider，全失败才抛错

## Fetch Provider 选择与回退

```
firecrawl（有 key 时） → jina → readability
       ↓ 任何错误（含空内容）均继续
     汇总所有错误，抛错
```

- 固定顺序，不需要 shuffle（Jina 免费，readability 本地零成本）
- 任何 provider 失败都继续下一家——Firecrawl 403 可能是自己的 IP 被拦，Jina 429 是限流，都不影响本地 Readability
- 零配置可用：Jina 和 readability 均无需 API key
- 任何错误（含空内容）都继续下一家，仅 abort 立即停止

## LLM 输出格式

每个 provider 返回的结果都经过格式化，确保 LLM 可判断相关性并选择要 fetch 的来源。

### Firecrawl / Exa 输出

```
Found 3 results:

**Documentation - TypeScript 5.9**
   https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html
   TypeScript 5.9 introduces support for ECMAScript's deferred module evaluation...

**Announcing TypeScript 5.9**
   https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/
   To help here, TypeScript 5.9 is now previewing a feature called expandable hover...
```

- LLM 直接根据 `title` 和 `description` 判断哪个结果最相关
- URL 可直接传给 `webfetch`

### Gemini 输出

Gemini 会生成 LLM 综述 + 行内引用标记，结果列表按编号对应：

```
TypeScript 5.9 introduces a range of new features, released in Q1 2026.[1]
Key new features include expandable hover information[2] and deferred module evaluation...[3]

---

Found 7 results:

[1] **digitalapplied.com**
   https://vertexaisearch.cloud.google.com/grounding-api-redirect/...

[2] **typescriptlang.org**
   https://vertexaisearch.cloud.google.com/grounding-api-redirect/...

[3] **microsoft.com**
   https://vertexaisearch.cloud.google.com/grounding-api-redirect/...
```

- LLM 先读综述（answer）了解搜索结果全貌
- 看到 `[1]` 引用 → 查 `[1] typescriptlang.org` → 调用 `webfetch` 获取该页全文
- 引用标记由 `groundingSupports` 自动插入，与 `groundingChunks` 顺序一致

### 内容截断

所有输出通过 `applyTruncation` 限制长度（默认 500 行 / 50KB），超出部分显示截断提示：

```
[Output truncated: 500 of 1234 lines (50.0 KB of 123.4 KB).]
```

## Abort 行为

`raceWithAbort` 将 pi 的 AbortSignal 与 provider 请求进行 race：

- signal 触发 → Promise reject，工具调用立即退出
- 底层 HTTP 请求可能仍在执行（SDK 不支持真正的 AbortSignal 传播）
- 实际超时保护由 provider 自身的 timeout 参数保证（Firecrawl 30s，Gemini 60s）

## 添加新 Provider

1. 创建 `service/newprovider.ts`，实现 `search(params: SearchParams): Promise<SearchResponse>`
2. 在 `service/index.ts` 中：
   - 导入 `hasNewProviderApiKey`（从 `config.ts` 添加）
   - 在 `getSearchProviders()` 中加入候选
   - 在 `SEARCH_IMPLS` 中注册实现
3. 在 `config.ts` 中：
   - 扩展 `PixConfig` 类型
   - 添加 `hasNewProviderApiKey()` / `getNewProviderApiKey()`
