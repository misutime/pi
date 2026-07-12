# repo-tools

GitHub 仓库能力扩展 — 结构化读取 GitHub 仓库、issue、PR 和代码搜索。

## 工具

| 工具 | 功能 | 需要认证 |
|---|---|---|
| `github_repo_view` | 查看仓库结构（目录树 + README）、目录列表、文件内容 | 公开仓库不需要 |
| `github_issue_view` | 查看 issue 详情和评论 | 公开仓库不需要 |
| `github_pr_view` | 查看 PR 详情、文件变更列表、review 和 CI 状态 | 公开仓库不需要 |
| `github_pr_diff` | 获取 PR 的 unified diff | 公开仓库不需要 |
| `github_code_search` | 跨仓库搜索 GitHub 代码（按语言/仓库/路径过滤） | **必须** |

## 认证

GitHub 公开仓库的元数据和内容可以匿名访问（repo_view、issue_view、pr_view、pr_diff）。但 **代码搜索（github_code_search）不支持匿名访问**，必须配置认证。

三种配置方式（任选一种）：

### 1. GitHub CLI（推荐）

安装 [GitHub CLI](https://cli.github.com/) 并登录：

```bash
gh auth login
```

登录后所有工具自动生效，包括私有仓库访问。

### 2. 环境变量

```bash
# Linux / macOS
export GITHUB_TOKEN=ghp_xxxxx

# Windows
set GITHUB_TOKEN=ghp_xxxxx
```

Token 在 https://github.com/settings/tokens 创建，**不需要勾选任何权限 scope**（只用于公开 API 调用）。

### 3. extensions.toml

在 `~/.pi/agent/extensions.toml` 中配置：

```toml
[repo-tools]
githubToken = "ghp_xxxxx"
```

## 参数约定

三个 issue/PR 工具使用相同的参数体系：

| 参数 | 说明 |
|---|---|
| `url` | 完整的 GitHub URL（优先级最高） |
| `repo` | `owner/repo` 格式 |
| `number` | issue/PR 编号。仅提供 number 时会从当前目录的 `git remote origin` 推断仓库 |

`github_repo_view` 额外支持 `path` 参数，指定仓库内的文件或目录路径。

## 实现

- 优先使用 `gh` CLI（处理登录、token、SSO、分页、JSON 输出）
- 无 `gh` 时 fallback GitHub REST API（通过 token 认证）
- 不需要 API token 的工具，无 token 也能查公开仓库
