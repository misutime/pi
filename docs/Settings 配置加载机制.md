# Settings 配置加载机制

## 文件位置

| 作用域 | 路径 | 说明 |
|--------|------|------|
| 全局 | `~/.pi/agent/settings.json` | 用户级配置，所有项目共享 |
| 项目 | `<cwd>/.pi/settings.json` | 项目级覆盖，仅受信任项目生效 |

`CONFIG_DIR_NAME` 默认为 `.pi`，可通过 `package.json` 的 `piConfig.configDir` 字段自定义。

源码入口：`packages/coding-agent/src/core/settings-manager.ts`

---

## 加载流程

```
SettingsManager.create(cwd, agentDir)
  ├── new FileSettingsStorage(cwd, agentDir)
  │     ├── globalSettingsPath = ~/.pi/agent/settings.json
  │     └── projectSettingsPath = cwd/.pi/settings.json
  ├── loadFromStorage(storage, "global")
  │     ├── 加文件锁 → readFileSync → JSON.parse
  │     └── migrateSettings()   ← 旧格式迁移
  ├── loadFromStorage(storage, "project", projectTrusted)
  │     └── 若项目不受信任 → 返回 {}
  └── deepMergeSettings(global, project)
        └── 递归合并，嵌套对象逐层覆盖（非整对象替换）
```

### 合并规则 (`deepMergeSettings`)

```ts
// 简化为：
// - 基本类型/数组：project 覆盖 global
// - 嵌套对象：递归合并 { ...global, ...project }
//
// 示例：
// global:  { compaction: { enabled: true, reserveTokens: 16384 } }
// project: { compaction: { reserveTokens: 32768 } }
// 结果:    { compaction: { enabled: true, reserveTokens: 32768 } }
```

### 旧格式迁移 (`migrateSettings`)

加载时自动转换旧字段，无需用户手动更新：

| 旧字段 | 新字段 |
|--------|--------|
| `queueMode` | `steeringMode` |
| `websockets: true/false` | `transport: "websocket"/"sse"` |
| `skills.customDirectories` | `skills` (直接数组) |
| `skills.enableSkillCommands` | `enableSkillCommands` (提升到顶层) |
| `retry.maxDelayMs` | `retry.provider.maxRetryDelayMs` |

---

## 访问接口

### 读取

- `getGlobalSettings()` — 全局设置的深拷贝 (`structuredClone`)
- `getProjectSettings()` — 项目设置的深拷贝
- 具体 getter（如 `getDefaultModel()`、`getTheme()`）— 读合并后的 `this.settings`（`global` + `project` 合并结果），带默认值

### 运行时覆盖

`applyOverrides(overrides)` — 在合并结果之上再叠加一层临时覆盖（如 CLI 参数），不影响持久化文件。

---

## 持久化

修改设置时调用对应的 setter（如 `setDefaultModel()`、`setTheme()`），内部流程：

```
setter()
  ├── 更新 this.globalSettings 或 this.projectSettings
  ├── markModified(field, nestedKey?)  ← 标记修改字段
  └── save()
        ├── 合并到 this.settings（运行时生效）
        └── enqueueWrite("global", task)
              ├── 排队串行执行（避免竞态）
              └── persistScopedSettings(scope, snapshot, modifiedFields, nestedFields)
                    ├── 读当前文件内容
                    ├── 仅合并被标记为 modified 的字段
                    └── 写回 JSON（格式化，2 空格缩进）
```

关键设计：**只写入被修改的字段**，不覆盖文件中用户手动编辑的其他字段。写入前会对目标文件加文件锁（`proper-lockfile`），最多重试 10 次，间隔 20ms。

---

## 项目信任机制

项目设置仅在项目"受信任"时加载和写入：

- `projectTrusted = false`：`loadFromStorage("project")` 返回 `{}`，写入时抛出 `"Project is not trusted"` 错误
- 用户通过 `/trust` 命令或首次启动时的信任提示确认后，`setProjectTrusted(true)` 重新加载项目设置

`defaultProjectTrust` 全局设置控制默认行为：`"ask"`（默认）、`"always"`、`"never"`。

---

## 完整配置字段

```ts
interface Settings {
  // 模型/Provider
  defaultProvider?: string;          // 默认 AI provider
  defaultModel?: string;             // 默认模型 ID
  defaultThinkingLevel?: ThinkingLevel;  // 默认思考等级
  enabledModels?: string[];          // 可用模型过滤（/model 切换时生效）
  transport?: TransportSetting;      // 传输协议: "auto" | "sse" | "websocket"
  retry?: RetrySettings;             // 重试策略

  // 会话
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  compaction?: CompactionSettings;   // 上下文压缩
  branchSummary?: BranchSummarySettings;
  sessionDir?: string;               // 自定义 session 存储目录

  // 界面
  theme?: string;
  hideThinkingBlock?: boolean;       // 隐藏思考块
  showCacheMissNotices?: boolean;    // 显示缓存未命中提示
  quietStartup?: boolean;
  collapseChangelog?: boolean;
  terminal?: TerminalSettings;       // 终端显示（图片、进度等）
  images?: ImageSettings;            // 图片处理（自动缩放、阻止发送）
  markdown?: MarkdownSettings;       // Markdown 渲染
  warnings?: WarningSettings;
  editorPaddingX?: number;
  outputPad?: 0 | 1;
  autocompleteMaxVisible?: number;
  showHardwareCursor?: boolean;

  // 快捷键
  doubleEscapeAction?: "fork" | "tree" | "none";
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";

  // 扩展/资源
  packages?: PackageSource[];        // npm/git 扩展包
  extensions?: string[];             // 本地扩展路径
  skills?: string[];                 // 本地 skill 路径
  prompts?: string[];                // 本地 prompt 模板路径
  themes?: string[];                 // 本地主题路径
  enableSkillCommands?: boolean;     // 注册 skills 为 /skill:name 命令

  // 外部工具
  externalEditor?: string;           // Ctrl+G 外部编辑器
  shellPath?: string;                // 自定义 shell 路径
  shellCommandPrefix?: string;       // bash 命令前缀
  npmCommand?: string[];             // npm 命令路径（如 mise exec）

  // 网络
  httpProxy?: string;                // HTTP 代理
  httpIdleTimeoutMs?: number;        // HTTP 空闲超时
  websocketConnectTimeoutMs?: number;

  // 隐私/遥测
  enableInstallTelemetry?: boolean;  // 匿名安装遥测
  enableAnalytics?: boolean;         // 分析数据（需主动开启）
  trackingId?: string;               // 分析标识符（自动生成）

  // 项目信任
  defaultProjectTrust?: DefaultProjectTrust;  // "ask" | "always" | "never"

  // 思考预算
  thinkingBudgets?: ThinkingBudgetsSettings;

  // 杂项
  lastChangelogVersion?: string;     // 上次显示的 changelog 版本
}
```

---

## 相关源码文件

| 文件 | 说明 |
|------|------|
| `packages/coding-agent/src/core/settings-manager.ts` | SettingsManager 核心实现 |
| `packages/coding-agent/src/config.ts` | CONFIG_DIR_NAME、getAgentDir 等路径常量 |
| `packages/coding-agent/src/core/project-trust.ts` | 项目信任判断 |
| `packages/coding-agent/src/core/trust-manager.ts` | 信任状态持久化 |
| `packages/coding-agent/src/main.ts` | 启动时初始化 SettingsManager + 应用 HTTP 代理 |
