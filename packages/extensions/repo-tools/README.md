# repo-tools

GitHub 仓库能力扩展 — 结构化读取 GitHub 仓库、issue、PR 和代码搜索。

## 工具

| 工具 | 功能 | 参数 | 认证 |
|---|---|---|---|
| `github_repo_view` | 仓库结构（目录树 + README）、目录列表、文件内容。支持自动检测文件/目录。 | `url?` / `repo?` + `path?` | 公开仓库不需要 |
| `github_issue_view` | Issue 详情和评论 | `url?` / `repo?` + `number?` | 公开仓库不需要 |
| `github_pr_view` | PR 详情、文件变更列表、review 和 CI 状态 | `url?` / `repo?` + `number?` | 公开仓库不需要 |
| `github_pr_diff` | PR unified diff（超出 100K 字符自动截断） | `url?` / `repo?` + `number?` | 公开仓库不需要 |
| `github_code_search` | 跨仓库搜索 GitHub 代码（按语言/仓库/路径过滤）。Legacy engine，不支持正则。限 10 req/min。 | `query`, `language?`, `repo?`, `path?`, `limit?` | **必须** |

### 参数约定

issue/PR 工具共用参数解析，优先级从高到低：

1. **`url`** — 完整的 GitHub URL，如 `https://github.com/earendil-works/pi/issues/123`
2. **`repo` + `number`** — 仓库名（`owner/repo` 格式）+ 编号
3. **仅 `number`** — 从当前目录的 `git remote origin` 推断仓库，推断失败时提示传 `url`

`github_repo_view` 的 `path` 参数支持仓库内路径（文件或目录），工具自动检测类型：

```text
{ repo: "earendil-works/pi", path: "README.md" }     → 文件内容
{ repo: "earendil-works/pi", path: "packages" }       → 目录列表
{ repo: "earendil-works/pi" }                         → 仓库首页（tree + README）
```

### URL 模式限制

URL 模式暂不支持分支名含 `/` 的情况（如 `/blob/feature/foo/src/a.ts`），因为无法可靠区分 ref 和 path 的边界。遇到这种 URL 请改用 `repo + path` 参数模式。

## 认证

GitHub 公开仓库的元数据和内容可以匿名访问（repo_view、issue_view、pr_view、pr_diff）。代码搜索（github_code_search）不支持匿名访问。

三种配置方式（任选一种）：

### 1. GitHub CLI（推荐）

安装 [GitHub CLI](https://cli.github.com/) 并登录：

```bash
gh auth login
```

登录后所有工具自动生效，支持私有仓库，无 rate limit 限制。

### 2. 环境变量

```bash
# Linux / macOS
export GITHUB_TOKEN=ghp_xxxxx

# Windows
set GITHUB_TOKEN=ghp_xxxxx
```

Token 在 https://github.com/settings/tokens 创建，**不需要勾选任何权限 scope**（仅用于公开 API 调用）。

### 3. extensions.toml

在 `~/.pi/agent/extensions.toml` 中配置：

```toml
[repo-tools]
githubToken = "ghp_xxxxx"
```

## 实现

### 优先级

```
有 gh 命令且可用 → gh CLI（处理认证、分页、JSON 输出、私有仓库）
无 gh 但有 token  → GitHub REST API（token 来自 env 或 extensions.toml）
无 gh 且无 token  → 公开仓库匿名访问（issue/PR/repo 可见，code_search 不可用）
```

### REPO VIEW 三种视图

| URL | 行为 |
|---|---|
| `https://github.com/o/r` | 返回目录树（跳过 `node_modules`、`dist` 等噪声目录）+ README |
| `.../tree/main/src` | 返回 `src/` 目录列表（含文件大小） |
| `.../blob/main/README.md` | 返回文件内容（文本显示，二进制显示元信息） |

目录树最多展示 200 项，README 截断于 16K 字符，文件内容截断于 60K 字符。

### 字段规范化

gh CLI 和 REST API 返回的字段名不同（`repository.nameWithOwner` vs `repository.full_name`、`user.login` vs `author.login` 等），所有工具在获取数据后统一规范化为通用结构，确保 formatter 正常工作。
