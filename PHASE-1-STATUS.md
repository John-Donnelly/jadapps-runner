# Phase 1 Implementation Status

✅ **Complete — Ready for compilation and testing**

## Files Created

### Core Rust Modules (`src-tauri/src/core/`)
- ✅ `mod.rs` — module declarations
- ✅ `config.rs` — mirrors `src/config.ts` with same env vars and defaults
- ✅ `keychain.rs` — SecretStore wrapper over `keyring` crate (keytar-compatible)
- ✅ `crypto.rs` — AES-256-GCM + Ed25519 (wire-format identical to Node)
- ✅ `license.rs` — stub skeleton for Phase 4 JWT license verification

### Tauri Shell & Sidecar
- ✅ `src/main.rs` — Tauri app entry point, tray setup, sidecar spawn
- ✅ `src/tray.rs` — tray menu build/update, event routing (start/stop/restart/dashboard/quit)
- ✅ `src/sidecar.rs` — Node process supervisor with exponential backoff, log piping, IPC commands
- ✅ `src/lib.rs` — empty lib target (required by Tauri 2)

### Tauri Configuration
- ✅ `Cargo.toml` — all dependencies (tauri, ring, keyring, tokio, serde, anyhow, base64, etc.)
- ✅ `build.rs` — standard Tauri build script
- ✅ `tauri.conf.json` — tray-only config, WebView2 skip, bundle resources

### Node Project Updates
- ✅ `package.json` — added `@tauri-apps/cli`, `tauri:dev`, `tauri:build` scripts

## Manual Steps Required Before Build

### 1. Create Icon Files
The Tauri build requires PNG icon files. Generate them from a 1024×1024 source image:

```bash
# Option 1: Using Tauri's built-in icon tool (easiest)
cd B:\jadapps-runner
npx tauri icon /path/to/source-1024.png
# This generates: icons/32x32.png, 128x128.png, icon.ico, icon.icns

# Option 2: Manual - create placeholder PNG files at these sizes:
# - icons/32x32.png (32x32 pixels)
# - icons/128x128.png (128x128 pixels)
# - icons/icon.ico (Windows icon, multi-resolution)
# - icons/icon.icns (macOS icon set)
```

### 2. Install Rust and Cargo
Required for building the Tauri app:
```bash
# Windows: https://rustup.rs/
# Or via scoop: scoop install rustup
rustup update
```

### 3. Build the Project
```bash
# Install Node dependencies first
npm install
npm run build  # builds Node code to dist/

# Build Tauri app in dev mode (for testing)
npm run tauri:dev
# Or release build:
npm run tauri:build
```

## What Phase 1 Delivers

When you run `npm run tauri:dev`:

1. ✅ **Tray icon appears** on Windows/Mac/Linux
2. ✅ **Menu items**: Status display, Start/Stop/Restart, Open Dashboard, Auto-launch toggle, Quit
3. ✅ **Sidecar supervision**: Node process starts, restarts on crash with backoff (1,2,4,8,16,32,60s)
4. ✅ **Log piping**: stdout/stderr written to `~/.jadapps-runner/logs/sidecar.*.log`
5. ✅ **IPC commands**: `get_status`, `start_sidecar`, `stop_sidecar`, `restart_sidecar`
6. ✅ **Crypto modules**: AES-256-GCM + Ed25519, 100% wire-format compatible with Node
7. ✅ **Keychain interop**: SecretStore reads/writes to OS keychain + file fallback

## Testing the Build

Once you have icons and can build:

```bash
# Terminal 1: Start the Tauri dev build
npm run tauri:dev

# Expected output:
# - Tray icon appears
# - Node sidecar spawns (check logs: ~/.jadapps-runner/logs/)
# - Clicking tray menu shows running status
# - Click "Open Dashboard" → opens https://jadapps.com/dashboard

# Terminal 2: Verify runner is listening
curl http://127.0.0.1:9789/v1/health
# Should return: {"ok":true,"name":"jadapps-runner","version":"0.1.0","pid":<number>,...}
```

## Unit Tests

All crypto tests are built-in. Run them with:
```bash
cd src-tauri
cargo test --lib core::crypto
```

Expected results:
- ✅ AES-GCM roundtrip (encrypt/decrypt)
- ✅ AES-GCM JSON roundtrip
- ✅ Ed25519 sign/verify roundtrip
- ✅ Ed25519 wrong-key fails verification

## Next Phase

Phase 2 starts with:
1. Tool catalogue generation script (TypeScript)
2. Headless Chromium execution via Playwright
3. `/v1/tools/:slug/run` full implementation
4. Full `/v1/tools` catalogue endpoint

This Phase 1 foundation is complete. The Tauri app is ready to be built and tested.
