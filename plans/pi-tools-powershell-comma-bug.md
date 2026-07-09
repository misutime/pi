# PowerShell 逗号导致 `--tools` 解析失败的 Bug

## 现象

PowerShell 下运行：

```powershell
pi --tools read,grep --exclude-tools read hello
```

预期：`grep` 为唯一活跃工具。
实际：**零个工具可用**。系统 prompt 中无 tools section，LLM 无法调用任何工具。

## 根因

PowerShell 在将参数传递给外部程序时，会把逗号 `,` 解释为数组元素分隔符，导致 `read,grep` 被转换为 `"read grep"`（空格连接）传给 `process.argv`。

`parseArgs` 中按逗号 split 的逻辑：

```ts
// packages/coding-agent/src/cli/args.ts L119-123
} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
    result.tools = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((name) => name.length > 0);
}
```

`"read grep".split(",")` → `["read grep"]`（单元素，逗号已丢失）。

结果：`allowedToolNames = ["read grep"]`，没有叫 `"read grep"` 的工具存在 → 注册层过滤掉所有工具 → `initialActiveToolNames = ["read grep"].filter(...)` = `["read grep"]`（不过滤，因为 denylist 里是 `"read"` 不是 `"read grep"`）→ `setActiveToolsByName(["read grep"])` → `_toolRegistry` 里找不到 → `agent.state.tools = []` → **零工具**。

## 证据

`debug-exclude.txt` 日志（`C:\Users\Misu\.pi\logs\debug-exclude.txt`）最后一行：

```
_excludedToolNames=["read"]
initialActiveToolNames=["read grep"]     ← 单元素，不是 ["read","grep"]
activeTools=["read grep"]
```

对比正常行（`cmd` 或其他 shell）：
```
initialActiveToolNames=["read","bash","edit","write"]
```

Session 文件 `019f4679-63e2-77a0-95eb-e017345dd685.jsonl` 中无 `active_tools_change` entry，LLM 日志中 system prompt 无 tools section，均佐证零工具激活。

## 影响范围

不仅是 `--tools`，所有使用逗号分隔值的 CLI 参数在 PowerShell 下都可能受影响：

| 参数 | 风险 |
|------|------|
| `--tools`, `-t` | 工具 allowlist 解析错误 |
| `--exclude-tools`, `-xt` | 工具 denylist 解析错误 |
| `--models` | 模型列表解析错误 |

## PowerShell 行为分析

PowerShell 在调用外部程序时：

1. `pi --tools read,grep` → PowerShell 将 `read,grep` 解析为数组 `@("read", "grep")`，然后以空格连接传给进程 → `process.argv` 收到 `"read grep"`
2. `pi --tools "read,grep"` → 双引号保护逗号 → `process.argv` 收到 `"read,grep"` ✅
3. `pi --tools 'read,grep'` → 单引号保护 → `process.argv` 收到 `"read,grep"` ✅
4. `pi --% --tools read,grep` → `--%` 停止 PowerShell 解析 → `process.argv` 收到 `"read,grep"` ✅

## 修复建议

### 方案 A：文档 + 引号提示（最小改动）

在 help 文本和文档中注明 PowerShell 下需要用引号包裹逗号分隔值：

```bash
# PowerShell 正确用法
pi --tools "read,grep" --exclude-tools "read"
```

### 方案 B：parseArgs 兼容空格分隔（代码修复）

在 `parseArgs` 中增加空格作为备用分隔符：

```ts
} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
    result.tools = args[++i]
        .split(/[,\s]+/)     // 同时支持逗号和空格分隔
        .map((s) => s.trim())
        .filter((name) => name.length > 0);
}
```

**风险**：工具名本身不能包含空格，但目前所有内置工具名（`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`）都不含空格，且命名规范也不允许空格，所以兼容空格是安全的。

同样应修复 `--exclude-tools` 和 `--models`。

### 方案 C：PowerShell 启动时检测并警告（辅助）

检测 `process.env` 中 PowerShell 特征（如 `PSModulePath`），在 help 中给出 PowerShell 专用提示。

## 建议

推荐**方案 A + B 组合**：
1. 代码层面兼容空格分隔（修复 `--tools`、`--exclude-tools`、`--models`）
2. 文档/help 中注明 PowerShell 推荐引号用法

这样既修复了实际 bug，又保留了引号方案作为最佳实践。
