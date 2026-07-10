# Set shell for non-Windows OSs:
set shell := ["zsh", "-euc"]

# Set shell for Windows OSs:
set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# List available recipes
default:
    @just --list

# Build all packages (ts → dist, with model fetch)
build:
    npm run build

# Build all packages skipping model fetch (local dev)
build-local:
    npm run build:local

# Lint + typecheck + shrinkwrap + browser smoke
check:
    npm run check

# Run coding-agent unit tests
[working-directory: 'packages/coding-agent']
test pattern="test/tools.test.ts":
    npx vitest run {{pattern}}

# Build + check + test (CI gate, with model fetch)
ci: build check test

# Build + check + test (local, skip model fetch)
ci-local: build-local check test

# Full pipeline for local testing (skip model fetch)
all OUT_DIR="../pi-local-release": ci-local
    npm run release:local -- --out {{OUT_DIR}} --force --skip-check --skip-build --skip-bun
    @echo ""
    @echo "=== Verify outside the repo ==="
    @echo "  {{OUT_DIR}}/node/pi --help"
    @echo "  {{OUT_DIR}}/node/pi -p \"say ok\""

# Full pipeline for production (with model fetch)
pro OUT_DIR="../pi-local-release": ci
    npm run release:local -- --out {{OUT_DIR}} --force --skip-check --skip-build --skip-bun
    @echo ""
    @echo "=== Verify outside the repo ==="
    @echo "  {{OUT_DIR}}/node/pi --help"
    @echo "  {{OUT_DIR}}/node/pi -p \"say ok\""

v: 
    ../pi-local-release./node/pi --version