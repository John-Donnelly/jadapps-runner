/**
 * Host hardware capability probe. Runs at runner boot, results are cached
 * in-process for the lifetime of the daemon. The output is what the runner
 * exposes to /v1/health and what downstream code consults to decide whether
 * to engage hardware-accelerated paths (ffmpeg encoder selection, sharp SIMD,
 * worker_threads pool sizing, Playwright WebGPU flags).
 *
 * Every individual probe is best-effort: any failure (missing tool, hostile
 * environment, unparseable output) falls back to a "feature unavailable"
 * shape without throwing. The probe is intentionally side-effect-free apart
 * from spawning short-lived child processes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, cpus, platform, totalmem } from "node:os";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

export type HardwareEncoder =
  | "h264_nvenc"
  | "hevc_nvenc"
  | "av1_nvenc"
  | "h264_qsv"
  | "hevc_qsv"
  | "av1_qsv"
  | "h264_amf"
  | "hevc_amf"
  | "av1_amf"
  | "h264_videotoolbox"
  | "hevc_videotoolbox"
  | "h264_vaapi"
  | "hevc_vaapi";

const KNOWN_HARDWARE_ENCODERS: readonly HardwareEncoder[] = [
  "h264_nvenc",
  "hevc_nvenc",
  "av1_nvenc",
  "h264_qsv",
  "hevc_qsv",
  "av1_qsv",
  "h264_amf",
  "hevc_amf",
  "av1_amf",
  "h264_videotoolbox",
  "hevc_videotoolbox",
  "h264_vaapi",
  "hevc_vaapi",
];

export interface CpuCaps {
  cores: number;
  model: string;
  arch: string;
  platform: string;
  totalMemoryBytes: number;
}

export interface GpuCaps {
  name: string;
  vendor: GpuVendor;
  driverVersion?: string;
  vramBytes?: number;
}

export interface FfmpegCaps {
  available: boolean;
  version?: string;
  hardwareEncoders: HardwareEncoder[];
}

export interface ImageCaps {
  sharpVersion?: string;
  libvipsVersion?: string;
  simd: boolean;
}

export interface HardwareCaps {
  cpu: CpuCaps;
  gpu: GpuCaps[];
  ffmpeg: FfmpegCaps;
  image: ImageCaps;
  probedAt: number;
}

let cached: HardwareCaps | null = null;
let inflight: Promise<HardwareCaps> | null = null;

/**
 * Probe the host once and cache the result. Subsequent calls within the
 * same process return the cached snapshot — useful for serving /v1/health
 * cheaply on every request without re-spawning probes.
 *
 * Pass `{ force: true }` to invalidate the cache (mostly for tests).
 */
export async function probeHardware(
  opts: { force?: boolean } = {},
): Promise<HardwareCaps> {
  if (cached && !opts.force) return cached;
  if (inflight && !opts.force) return inflight;
  inflight = doProbe();
  try {
    cached = await inflight;
    return cached;
  } finally {
    inflight = null;
  }
}

async function doProbe(): Promise<HardwareCaps> {
  const [gpu, ffmpeg, image] = await Promise.all([
    probeGpu().catch(() => [] as GpuCaps[]),
    probeFfmpeg().catch(
      (): FfmpegCaps => ({ available: false, hardwareEncoders: [] }),
    ),
    probeImage().catch((): ImageCaps => ({ simd: false })),
  ]);
  return {
    cpu: probeCpu(),
    gpu,
    ffmpeg,
    image,
    probedAt: Date.now(),
  };
}

function probeCpu(): CpuCaps {
  const list = cpus();
  return {
    cores: list.length,
    model: list[0]?.model.trim() ?? "unknown",
    arch: arch(),
    platform: platform(),
    totalMemoryBytes: totalmem(),
  };
}

async function probeGpu(): Promise<GpuCaps[]> {
  switch (platform()) {
    case "win32":
      return probeGpuWindows();
    case "darwin":
      return probeGpuMac();
    case "linux":
      return probeGpuLinux();
    default:
      return [];
  }
}

async function probeGpuWindows(): Promise<GpuCaps[]> {
  // CIM is the modern WMI replacement and is available on all supported
  // Windows builds. Output is JSON so we don't have to scrape whitespace.
  const script =
    "Get-CimInstance Win32_VideoController | " +
    "Select-Object Name, AdapterCompatibility, DriverVersion, AdapterRAM | " +
    "ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
  );
  return parseWindowsGpu(stdout);
}

export function parseWindowsGpu(stdout: string): GpuCaps[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const entries: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : [parsed as Record<string, unknown>];
  return entries
    .filter((e) => typeof e === "object" && e !== null)
    .map((e): GpuCaps => {
      const name = typeof e.Name === "string" ? e.Name : "unknown";
      const compat =
        typeof e.AdapterCompatibility === "string" ? e.AdapterCompatibility : "";
      const out: GpuCaps = {
        name,
        vendor: vendorFromString(`${name} ${compat}`),
      };
      if (typeof e.DriverVersion === "string" && e.DriverVersion) {
        out.driverVersion = e.DriverVersion;
      }
      // AdapterRAM is reported as a signed 32-bit int and overflows for >=4GB
      // cards; treat negative values as "unknown" rather than misreporting.
      if (typeof e.AdapterRAM === "number" && e.AdapterRAM > 0) {
        out.vramBytes = e.AdapterRAM;
      }
      return out;
    });
}

async function probeGpuMac(): Promise<GpuCaps[]> {
  const { stdout } = await execFileAsync(
    "system_profiler",
    ["SPDisplaysDataType", "-json"],
    { timeout: PROBE_TIMEOUT_MS },
  );
  return parseMacGpu(stdout);
}

export function parseMacGpu(stdout: string): GpuCaps[] {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const list = parsed.SPDisplaysDataType;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e): GpuCaps => {
        const name =
          typeof e.sppci_model === "string"
            ? e.sppci_model
            : typeof e._name === "string"
              ? e._name
              : "unknown";
        const vendor =
          typeof e.spdisplays_vendor === "string"
            ? vendorFromString(e.spdisplays_vendor)
            : vendorFromString(name);
        return { name, vendor };
      });
  } catch {
    return [];
  }
}

async function probeGpuLinux(): Promise<GpuCaps[]> {
  // lspci is the most portable Linux GPU enumeration. We grep for class 03xx
  // (Display controller) which catches both VGA and 3D-only adapters.
  const { stdout } = await execFileAsync("lspci", ["-mm", "-nn"], {
    timeout: PROBE_TIMEOUT_MS,
  });
  return parseLinuxGpu(stdout);
}

export function parseLinuxGpu(stdout: string): GpuCaps[] {
  const out: GpuCaps[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\b(VGA compatible controller|3D controller|Display controller)\b/.test(line)) {
      continue;
    }
    // `lspci -mm -nn` puts the slot bus unquoted at the start, then quoted
    // strings for [0] class, [1] vendor, [2] model. Older lspci builds may
    // omit the model; be defensive about both slots.
    const parts = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    const vendor = parts[1] ?? "";
    const model = parts[2] ?? "";
    out.push({
      name: `${vendor} ${model}`.trim() || "unknown",
      vendor: vendorFromString(`${vendor} ${model}`),
    });
  }
  return out;
}

export function vendorFromString(s: string): GpuVendor {
  // Normalize so `\b` reliably bounds tokens — without this, "ati" inside
  // "Corporation" matches the AMD branch, and "Apple" inside the macOS
  // sentinel "sppci_vendor_Apple" misses because `_` is a word char.
  const lc = s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(nvidia|geforce|quadro|tesla|rtx|gtx)\b/.test(lc)) return "nvidia";
  if (/\b(amd|radeon|ati|ryzen)\b/.test(lc)) return "amd";
  if (/\b(intel|iris|arc)\b/.test(lc) || /\b(uhd|hd) graphics\b/.test(lc)) return "intel";
  if (/\b(apple|m1|m2|m3|m4)\b/.test(lc)) return "apple";
  return "other";
}

async function probeFfmpeg(): Promise<FfmpegCaps> {
  const version = await getFfmpegVersion();
  if (!version) return { available: false, hardwareEncoders: [] };
  const encoders = await getFfmpegEncoders();
  return { available: true, version, hardwareEncoders: encoders };
}

async function getFfmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-version"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const m = stdout.match(/ffmpeg version (\S+)/);
    return m?.[1] ?? "unknown";
  } catch {
    return null;
  }
}

async function getFfmpegEncoders(): Promise<HardwareEncoder[]> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-encoders"],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parseFfmpegEncoders(stdout);
  } catch {
    return [];
  }
}

export function parseFfmpegEncoders(stdout: string): HardwareEncoder[] {
  // Encoder lines after the "------" separator look like:
  //   " V....D h264_nvenc           NVIDIA NVENC H.264 encoder"
  // The flags column ends at the first whitespace before the encoder name.
  const lines = stdout.split(/\r?\n/);
  const found = new Set<HardwareEncoder>();
  for (const line of lines) {
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (!m) continue;
    const name = m[1] as HardwareEncoder;
    if (KNOWN_HARDWARE_ENCODERS.includes(name)) found.add(name);
  }
  return [...found];
}

async function probeImage(): Promise<ImageCaps> {
  try {
    const mod = (await import("sharp")) as unknown as {
      default: {
        versions?: { vips?: string };
        simd?: () => boolean;
      };
      versions?: { vips?: string };
      simd?: () => boolean;
    };
    const sharp = mod.default ?? mod;
    const libvipsVersion =
      sharp.versions?.vips ?? (mod as { versions?: { vips?: string } }).versions?.vips;
    const simd = typeof sharp.simd === "function" ? !!sharp.simd() : false;
    const caps: ImageCaps = { simd };
    if (libvipsVersion) caps.libvipsVersion = libvipsVersion;
    return caps;
  } catch {
    return { simd: false };
  }
}
