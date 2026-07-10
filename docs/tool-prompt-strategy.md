# 扩展工具的提示词策略

pi 自定义工具有三个影响 LLM 行为的字段：

| 字段 | 出现位置 | 作用 |
|------|----------|------|
| `description` | tools JSON schema | LLM 选择工具时的主要参考 |
| `promptSnippet` | 系统提示 "Available tools" 摘要区 | 一行清单，让 LLM 知道工具存在 |
| `promptGuidelines` | 系统提示 "Guidelines" 区块 | 策略性行为指引 |

## 影响力排序

**`description` >> `promptGuidelines` > `promptSnippet`**

`description` 在 LLM 的 function calling schema 里，模型专门针对这个字段做了工具选择训练。后两者埋在系统提示的其他位置，注意力更分散。

## 原则

**只写 `description`。** 大多数工具只需要描述清楚功能即可，LLM 知道什么时候用它。

**不加 `promptSnippet`**，除非你希望工具出现在 "Available tools" 清单里给人看。

**不加 `promptGuidelines`**，除非不写会导致 LLM 选择错误工具。有价值的 guideline 不是重复 description 已经说过的内容，而是**纠正系统偏好**或**消除歧义**。

## `promptGuidelines` 注意事项

**每条 guideline 必须带工具名**，因为 guideline 追加到 Guidelines 区块时没有工具名前缀——所有扩展的 guideline 混在一起。

```typescript
// ✅ 正确：LLM 知道这是哪个工具
promptGuidelines: [
  "Use lsp rename for cross-file symbol renames — never use sed or hand edits.",
  "Use webfetch when the user asks to read online documentation or API specs.",
]

// ❌ 错误：LLM 不知道"此工具"是谁
promptGuidelines: [
  "Use this tool for cross-file symbol renames.",
  "Use this tool when the user asks to read online documentation.",
]
```

## 什么时候需要 `promptGuidelines`

### 需要写（纠正偏好）

LLM 天然倾向于用它能完全控制的工具。当存在**更精确的外部工具但模型不知道信任它**时：

```
NEVER do a cross-file rename with ast_edit, sed, or hand edits when lsp rename can — text renames silently drop callsites.
```

```
Use webfetch to read web documentation instead of relying on training data — content may be outdated.
```

### 不需要写（重复废话）

以下这些 guideline 是 worthless，因为 `description` 已经表达了：

```
Use webfetch when you need to fetch a URL.
Use lsp when you need language server diagnostics.
Use my_calc when you need to compute numbers.
```

## 好的 `description` 写法

- 一句话说清输入输出
- 包含约束条件（URL 必须 http/https、上限字符数）
- 不需要 emoji、分节标题、Markdown 格式

```typescript
// ✅ 好
description: `Fetches content from a URL and returns the extracted text.
Use this to read web pages, documentation, or API responses.
Accepts http:// and https:// URLs. Returns up to 100,000 characters.`

// ❌ 差：废话连篇
description: "This powerful tool enables you to fetch remote web content...\n\n## Features\n- ...\n\n## Usage\n- ..."
```
