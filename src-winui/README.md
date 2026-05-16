# `src-winui/` — WinUI3 native host (Windows primary)

Native Windows tray-only app that supervises the Node sidecar and
exposes the same surface as the Tauri host (`src-tauri/`). Two
projects:

| Project | Targets | Builds with |
|---|---|---|
| **JadAppsRunner.Core** | `net8.0` | Pure .NET 8 — no Windows App SDK required. Sidecar supervisor, settings client, preauth URL parsing, AES-GCM + Ed25519 helpers. `dotnet build` works on any machine with the .NET 8 SDK. |
| **JadAppsRunner.Host** | `net8.0-windows10.0.19041.0` | WinUI3 entry point + tray icon. Needs Windows App SDK 1.6 build tools (NuGet restores them) + Windows 10.0.17763 SDK to compile. MSIX-packaged. |
| **JadAppsRunner.Core.Tests** | xUnit | All Core logic gets parity tests here. Run with `dotnet test`. |

## Build prerequisites

| Tool | Why |
|---|---|
| .NET SDK 8.0+ | Both Core and Host target net8.0. |
| Windows 10/11 with **Windows 10 SDK 10.0.17763** or newer | For Host's WinUI3 compile. The Core project + tests do not need this. |
| Node.js 20.10+ | `stage-winui-bundle.mjs` invokes `npm ci --omit=dev` to materialise the Node sidecar bundle. |

## Build + test (Core only — works anywhere)

```powershell
cd src-winui
dotnet test JadAppsRunner.Core.Tests
```

## Build Host (needs Windows + WinAppSDK)

```powershell
# From the repo root
npm run build           # tsup → dist/
npm run winui:stage     # stages Assets/runtime-bundle/ via shared script
dotnet build src-winui/JadAppsRunner.Host -c Release
```

`dotnet build` triggers the `StageRuntimeBundle` target which calls
`npm run winui:stage` automatically. If you've already staged manually,
pass `/p:SkipNodeStage=true` to skip it.

## MSIX packaging

```powershell
dotnet publish src-winui/JadAppsRunner.Host -c Release `
  /p:GenerateAppxPackageOnBuild=true `
  /p:AppxPackageSigningEnabled=false `
  /p:Platform=x64
```

(Signing requires a code-signing cert; the `AppxPackageSigningEnabled`
flag is off for local dev builds.)

## Wire-format parity

The Host calls the Node sidecar over the same loopback HTTP surface
the Tauri host uses, with the same Bearer pairing token. No new
endpoints, no IPC. Behavioural parity is enforced by:

- `JadAppsRunner.Core.Tests.AesGcm256Tests` — round-trip + fixed-nonce
  determinism vs the Node-side `encryptJson()`.
- `JadAppsRunner.Core.Tests.Ed25519SignerTests` — signs payloads the
  Node side can verify and vice versa.
- `JadAppsRunner.Core.Tests.PreauthHandlerTests` — parses the same
  `jadapps-runner://pair?token=...` URLs as the Rust `preauth.rs`,
  produces the same marker JSON shape.
- `JadAppsRunner.Core.Tests.SettingsClientTests` — exercises the
  same `/v1/settings` request/response shapes as the Tauri client.

## What's deliberately left for follow-up

- **Settings page (XAML window)** — the tray menu currently uses the
  native folder picker. A full NavigationView-style settings window
  comes when the UI grows beyond tray.
- **HWND init for FolderPicker** — picker currently has no owner
  window; needs `WinRT.Interop.InitializeWithWindow` against a hidden
  XAML window so the dialog appears in the foreground reliably.
- **Auto-update channel** — MSIX side-loading installs don't
  auto-update by default. Hook into Windows Package Manager (winget)
  or a Microsoft Store entry.
- **macOS / Linux** — those stay on the Tauri host (`src-tauri/`),
  which builds `.app` and `.AppImage` after the `msi` target drop.

See [`ARCHITECTURE-FUTURE.md`](../ARCHITECTURE-FUTURE.md) for ECSIE
and MCP-orchestrator placement plans — both target this WinUI3 shell
as their UI host.
