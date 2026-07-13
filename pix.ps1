# pix.ps1 — 从任意目录启动 pi 开发模式
# 用法: pix [pi 参数...]
#       放在 $env:PATH 中的目录，或添加到 PowerShell profile

$ErrorActionPreference = "Stop"

# 找到脚本所在目录 = repo 根目录
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$tsxBin = Join-Path $repoRoot "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found. Run 'npm install' from $repoRoot first."
}
$cliPath = Join-Path $repoRoot "packages/coding-agent/src/cli.ts"
& $tsxBin $cliPath @args
