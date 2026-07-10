# Fork 适配 TODO

> 将 `@earendil-works/pi-*` → `@misutime/pi-*`，仓库 `earendil-works/pi-mono` → `misutime/pi`

## 1. package.json（包名 + 内部依赖）

| 文件 | 修改内容 |
|------|----------|
| `packages/ai/package.json` | `name` → `@misutime/pi-ai`，`repository.url` |
| `packages/tui/package.json` | `name` → `@misutime/pi-tui`，`repository.url` |
| `packages/agent/package.json` | `name` → `@misutime/pi-agent-core`，`repository.url` |
| `packages/coding-agent/package.json` | `name` → `@misutime/pi-coding-agent`，`dependencies` 中三个 `@earendil-works/pi-*` → `@misutime/pi-*`，`repository.url` |
| `packages/orchestrator/package.json` | `name` → `@misutime/pi-orchestrator`，`dependencies` 中 `@earendil-works/pi-coding-agent` → `@misutime/pi-coding-agent` |
| `packages/coding-agent/install-lock/package.json` | `name` → `@misutime/pi-coding-agent-install`，依赖 → `@misutime/pi-coding-agent` |
| `packages/coding-agent/npm-shrinkwrap.json` | 全局替换 `@earendil-works/pi-*` → `@misutime/pi-*`，重新生成 |
| `packages/coding-agent/install-lock/package-lock.json` | 全局替换，重新生成 |

## 2. TypeScript 源码 import

> 涉及 `packages/coding-agent/src/`、`packages/orchestrator/src/`、`packages/tui/` 中所有 `@earendil-works/pi-*` import，共约 150+ 处。全局搜索替换即可：

```bash
# 先在 coding-agent/src 中替换
grep -rl '@earendil-works/pi-' packages/coding-agent/src/ | xargs sed -i 's/@earendil-works\/pi-/@misutime\/pi-/g'
# orchestrator/src
grep -rl '@earendil-works/pi-' packages/orchestrator/src/ | xargs sed -i 's/@earendil-works\/pi-/@misutime\/pi-/g'
# tui（README 示例代码）
grep -rl '@earendil-works/pi-' packages/tui/ | xargs sed -i 's/@earendil-works\/pi-/@misutime\/pi-/g'
```

## 3. config.ts 硬编码

| 行 | 当前值 | 改为 |
|----|--------|------|
| `src/config.ts:336` | `https://github.com/earendil-works/pi-mono/releases/latest` | `https://github.com/misutime/pi/releases/latest` |
| `src/config.ts:488` | `"@earendil-works/pi-coding-agent"`（fallback） | `"@misutime/pi-coding-agent"` |

## 4. startup-ui.ts 硬编码

| 行 | 当前值 | 改为 |
|----|--------|------|
| `src/cli/startup-ui.ts:26` | `OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent"` | `"@misutime/pi-coding-agent"` |

## 5. utils/changelog.ts 硬编码

| 行 | 当前值 | 改为 |
|----|--------|------|
| `src/utils/changelog.ts:11` | `GITHUB_REPO = "earendil-works/pi"` | `"misutime/pi"` |

## 6. tsconfig 路径映射

| 文件 | 修改 |
|------|------|
| `tsconfig.json` | 全部 `@earendil-works/pi-*` paths → `@misutime/pi-*` |
| `packages/coding-agent/tsconfig.examples.json` | 同上 |
| `packages/coding-agent/vitest.config.ts` | alias 中的 `@earendil-works/pi-*` → `@misutime/pi-*` |

## 7. 脚本

| 文件 | 修改 |
|------|------|
| `scripts/publish.mjs` | `packages` 数组中 4 个包名 → `@misutime/pi-*` |
| `scripts/local-release.mjs` | 同上 |
| `scripts/generate-coding-agent-shrinkwrap.mjs` | `internalPackagePrefix` → `@misutime/pi-` |
| `scripts/generate-coding-agent-install-lock.mjs` | `internalPackagePrefix` + `installPackageName` |
| `scripts/check-pinned-deps.mjs` | 前缀判断 `@earendil-works/pi-` → `@misutime/pi-` |
| `scripts/release-notes.mjs` | `DEFAULT_REPO` → `misutime/pi` |
| `scripts/browser-smoke-entry.ts` | import 路径 |

## 8. 文档

| 文件 | 修改 |
|------|------|
| `README.md` | npm badge URL、包名列表、导入示例 |
| `packages/*/README.md` | 各包 README 中的包名和导入示例 |
| `docs/开发与发布指南.md` | 包名引用 |

## 9. CI / GitHub Actions

| 文件 | 修改 |
|------|------|
| `.github/workflows/build-binaries.yml` | `environment: npm-publish` 对应的 GitHub Environment 配置 |
| 各 workflow | 仓库引用（如有） |

## 10. npm 发布配置

- 在 npm 上创建 `@misutime` scope
- 在 npm 包设置中配置 trusted publishing，关联 `misutime/pi` 仓库
- 或改为手动发布（见 `docs/开发与发布指南.md` 第 4 节）

## 11. 不再需要的配置

| 文件 | 操作 |
|------|------|
| `.npmrc` | 已删除 `min-release-age=2`（✅ 已完成） |

---

> **建议执行顺序**：先改 `package.json` → `tsconfig.json` → 全局替换源码 import → 脚本 → config.ts 硬编码 → 文档 → CI
