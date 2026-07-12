# 开发指南

## 快速开始

将 repo 根目录加入用户级 `PATH`（推荐，cmd/pwsh/bash 通用）：

```powershell
# 一次性设置，永久生效
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";D:\misutime\102_pi\pi", "User")
```

```bash
# macOS / Linux bash/zsh
echo 'export PATH="$HOME/path/to/pi:$PATH"' >> ~/.zshrc
```

重启终端后，任意目录：

```bash
pix                 # 启动 TUI
pix -p "hello"      # 单次 prompt
pix --help          # 查看参数
```

删除 PATH：

```powershell
# 移除 repo 目录
$path = [Environment]::GetEnvironmentVariable("Path", "User")
$path = ($path -split ";" | Where-Object { $_ -ne "D:\misutime\102_pi\pi" }) -join ";"
[Environment]::SetEnvironmentVariable("Path", $path, "User")
```

## 运行 dev 模式

不需要编译，tsx 直接运行 TypeScript 源码：

```bash
# 启动交互式 TUI（dev 模式）
./pi-test.ps1          # Windows PowerShell
./pi-test.sh           # macOS / Linux
./pi-test.bat          # Windows CMD

# 等价于手动：
npx tsx packages/coding-agent/src/cli.ts
```

所有 workspace 包（ai、agent、tui、coding-agent）均以 `.ts` 源码联动加载，根 `tsconfig.json` 中的 paths 映射自动解析。

## 开发迭代

```
修改源码 → 重新运行 ./pi-test.ps1 → 立即生效
```

无需 `npm run build` 或 `npm run dev`，tsx 直接执行源码。仅最终发布时需要 `just all` 打包。

## workspace 结构

```
packages/
├── ai/              # 模型提供商、API 封装
├── agent/           # Agent 核心逻辑
├── coding-agent/    # CLI 入口、工具、会话管理
├── orchestrator/    # 多 agent 编排
└── tui/             # 终端 UI

extensions/
└── pix/             # 扩展：web search / fetch 等
```

## 常用命令

```bash
npm run check        # lint + typecheck + 依赖验证
just test [pattern]  # 运行 vitest
just all             # 完整构建 + 本地 release 包
```
