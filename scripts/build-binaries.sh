#!/usr/bin/env bash
#
# Build pi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-deps] [--skip-build] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install      Skip pnpm install
#   --skip-deps         Skip installing cross-platform dependencies
#   --skip-build        Skip pnpm run build
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>         Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     pi-darwin-arm64.tar.gz
#     pi-darwin-x64.tar.gz
#     pi-linux-x64.tar.gz
#     pi-linux-arm64.tar.gz
#     pi-windows-x64.zip
#     pi-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    pnpm install --frozen-lockfile --ignore-scripts
else
    echo "==> Skipping pnpm install (--skip-install)"
fi

NATIVE_DEPS_DIR=""
cleanup() {
    if [[ -n "$NATIVE_DEPS_DIR" ]]; then
        rm -rf "$NATIVE_DEPS_DIR"
    fi
}
trap cleanup EXIT

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings in an isolated workspace..."
    # Keep the reviewed workspace manifests and lockfile immutable. The isolated
    # workspace uses the same frozen lock and asks pnpm to materialize every
    # architecture needed by Bun cross-compilation.
    NATIVE_DEPS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-native-deps.XXXXXX")"
    mkdir -p "$NATIVE_DEPS_DIR/packages"
    cp package.json pnpm-lock.yaml "$NATIVE_DEPS_DIR/"
    cp pnpm-workspace.yaml "$NATIVE_DEPS_DIR/"
    for package in ai agent tui coding-agent; do
        mkdir -p "$NATIVE_DEPS_DIR/packages/$package"
        cp "packages/$package/package.json" "$NATIVE_DEPS_DIR/packages/$package/"
    done
    cat >> "$NATIVE_DEPS_DIR/pnpm-workspace.yaml" <<'EOF'
supportedArchitectures:
  os: [darwin, linux, win32]
  cpu: [arm64, x64]
  libc: [glibc, musl]
EOF
    pnpm --dir "$NATIVE_DEPS_DIR" install \
        --filter @earendil-works/pi-coding-agent \
        --prod \
        --frozen-lockfile \
        --ignore-scripts
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    echo "==> Building all packages..."
    pnpm run build
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
PHOTON_WASM="$(node --input-type=module -e "import { createRequire } from 'node:module'; const require = createRequire(new URL('./packages/coding-agent/package.json', import.meta.url)); console.log(require.resolve('@silvia-odwyer/photon-node/photon_rs_bg.wasm'));")"
CLIPBOARD_DIR="$(node --input-type=module -e "import { dirname } from 'node:path'; import { createRequire } from 'node:module'; const require = createRequire(new URL('./packages/coding-agent/package.json', import.meta.url)); console.log(dirname(require.resolve('@mariozechner/clipboard/package.json')));")"
CLIPBOARD_RESOLUTION_ROOT="$(pwd)"
if [[ -n "$NATIVE_DEPS_DIR" ]]; then
    CLIPBOARD_RESOLUTION_ROOT="$NATIVE_DEPS_DIR"
fi

resolve_clipboard_native_dir() {
    node --input-type=module -e "
        import { dirname, join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { createRequire } from 'node:module';
        const codingAgentRequire = createRequire(pathToFileURL(join(process.argv[1], 'packages/coding-agent/package.json')));
        const clipboardRequire = createRequire(codingAgentRequire.resolve('@mariozechner/clipboard/package.json'));
        console.log(dirname(clipboardRequire.resolve('@mariozechner/' + process.argv[2] + '/package.json')));
    " "$CLIPBOARD_RESOLUTION_ROOT" "$1"
}

cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --target=bun-$platform ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/pi.exe"
    else
        bun build --compile --target=bun-$platform ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/pi"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp "$PHOTON_WASM" "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    case "$platform" in
        darwin-arm64)
            clipboard_native_package="clipboard-darwin-arm64"
            ;;
        darwin-x64)
            clipboard_native_package="clipboard-darwin-x64"
            ;;
        linux-x64)
            clipboard_native_package="clipboard-linux-x64-gnu"
            ;;
        linux-arm64)
            clipboard_native_package="clipboard-linux-arm64-gnu"
            ;;
        windows-x64)
            clipboard_native_package="clipboard-win32-x64-msvc"
            ;;
        windows-arm64)
            clipboard_native_package="clipboard-win32-arm64-msvc"
            ;;
    esac
    clipboard_native_dir="$(resolve_clipboard_native_dir "$clipboard_native_package")"
    mkdir -p "$OUTPUT_DIR/$platform/node_modules/@mariozechner"
    cp -r "$CLIPBOARD_DIR" "$OUTPUT_DIR/$platform/node_modules/@mariozechner/clipboard"
    cp -r "$clipboard_native_dir" "$OUTPUT_DIR/$platform/node_modules/@mariozechner/$clipboard_native_package"

    # Copy terminal input native helpers next to compiled binaries.
    if [[ "$platform" == darwin-* ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform"
        cp ../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform/"
    fi
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir"
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir/"
    fi
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating pi-$platform.zip..."
        (cd "$platform" && zip -r ../pi-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating pi-$platform.tar.gz..."
        mv "$platform" pi && tar -czf pi-$platform.tar.gz pi && mv pi "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../pi-$platform.zip)
    else
        tar -xzf pi-$platform.tar.gz && mv pi "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/pi.exe"
    else
        echo "  $OUTPUT_DIR/$platform/pi"
    fi
done
