# Set shell for non-Windows OSs:
set shell := ["zsh", "-euc"]

# Set shell for Windows OSs:
set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# List available recipes
default:
    @just --list

# Build all packages (ts → dist)
build:
    npm run build

# Lint + typecheck + shrinkwrap + browser smoke
check:
    npm run check

# Run coding-agent unit tests
[working-directory: 'packages/coding-agent']
test pattern="test/tools.test.ts":
    npx vitest run {{pattern}}

# Build + check + test (CI gate)
ci: build check test

# Full pipeline: ci → local release → verify
all OUT_DIR="../pi-local-release": ci
    npm run release:local -- --out {{OUT_DIR}} --force --skip-check --skip-build --skip-bun
    @echo ""
    @echo "=== Verify outside the repo ==="
    @echo "  {{OUT_DIR}}/node/pi --help"
    @echo "  {{OUT_DIR}}/node/pi -p \"say ok\""

v: 
    ../pi-local-release./node/pi --version