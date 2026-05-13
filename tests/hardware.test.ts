import { describe, expect, it } from "vitest";
import {
  parseFfmpegEncoders,
  parseLinuxGpu,
  parseMacGpu,
  parseWindowsGpu,
  probeHardware,
  vendorFromString,
} from "../src/runtime/hardware";

describe("vendorFromString", () => {
  it("classifies common GPU vendor strings", () => {
    expect(vendorFromString("NVIDIA GeForce RTX 4090")).toBe("nvidia");
    expect(vendorFromString("AMD Radeon RX 7900 XTX")).toBe("amd");
    expect(vendorFromString("Intel(R) Iris Xe Graphics")).toBe("intel");
    expect(vendorFromString("Apple M2 Max")).toBe("apple");
    expect(vendorFromString("VirtualBox SVGA Adapter")).toBe("other");
  });
});

describe("parseWindowsGpu", () => {
  it("parses single-adapter CIM JSON", () => {
    const stdout = JSON.stringify({
      Name: "NVIDIA GeForce RTX 4090",
      AdapterCompatibility: "NVIDIA",
      DriverVersion: "31.0.15.3699",
      AdapterRAM: -1,
    });
    expect(parseWindowsGpu(stdout)).toEqual([
      {
        name: "NVIDIA GeForce RTX 4090",
        vendor: "nvidia",
        driverVersion: "31.0.15.3699",
      },
    ]);
  });

  it("parses multi-adapter CIM JSON arrays", () => {
    const stdout = JSON.stringify([
      { Name: "NVIDIA GeForce RTX 4090", AdapterCompatibility: "NVIDIA", AdapterRAM: 2147483647 },
      { Name: "Intel(R) UHD Graphics", AdapterCompatibility: "Intel" },
    ]);
    const out = parseWindowsGpu(stdout);
    expect(out.map((g) => g.vendor)).toEqual(["nvidia", "intel"]);
    expect(out[0]?.vramBytes).toBe(2147483647);
    expect(out[1]?.vramBytes).toBeUndefined();
  });

  it("returns [] on empty or non-JSON input", () => {
    expect(parseWindowsGpu("")).toEqual([]);
    expect(parseWindowsGpu("   ")).toEqual([]);
    expect(parseWindowsGpu("not json")).toEqual([]);
  });
});

describe("parseMacGpu", () => {
  it("parses system_profiler -json output", () => {
    const stdout = JSON.stringify({
      SPDisplaysDataType: [
        {
          sppci_model: "Apple M2 Max",
          spdisplays_vendor: "sppci_vendor_Apple",
        },
      ],
    });
    expect(parseMacGpu(stdout)).toEqual([
      { name: "Apple M2 Max", vendor: "apple" },
    ]);
  });
});

describe("parseLinuxGpu", () => {
  it("parses lspci -mm -nn output for VGA and 3D classes", () => {
    const stdout =
      '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GA102 [GeForce RTX 3090] [2204]" -rc \n' +
      '00:02.0 "Display controller [0380]" "Intel Corporation [8086]" "AlderLake-S GT1 [630] [4690]"\n' +
      '02:00.0 "Ethernet controller [0200]" "Realtek [10ec]" "RTL8125 [8125]"\n';
    const out = parseLinuxGpu(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]?.vendor).toBe("nvidia");
    expect(out[1]?.vendor).toBe("intel");
  });
});

describe("parseFfmpegEncoders", () => {
  it("extracts only the known hardware-accelerated encoders", () => {
    const stdout = [
      "Encoders:",
      " V..... = Video",
      " ------",
      " V....D h264_nvenc           NVIDIA NVENC H.264 encoder",
      " V....D hevc_nvenc           NVIDIA NVENC HEVC encoder",
      " V....D h264_qsv             H.264 (Intel Quick Sync Video)",
      " V....D libx264              libx264 H.264",
      " A..... aac                  AAC (Advanced Audio Coding)",
    ].join("\n");
    const found = parseFfmpegEncoders(stdout).sort();
    expect(found).toEqual(["h264_nvenc", "h264_qsv", "hevc_nvenc"]);
  });

  it("returns [] when ffmpeg has no hardware encoders compiled in", () => {
    const stdout = " V..... libx264              libx264 H.264";
    expect(parseFfmpegEncoders(stdout)).toEqual([]);
  });
});

describe("probeHardware", () => {
  it("returns a fully-formed snapshot with real CPU info", async () => {
    const caps = await probeHardware({ force: true });
    expect(caps.cpu.cores).toBeGreaterThan(0);
    expect(caps.cpu.arch).toBeTruthy();
    expect(caps.cpu.platform).toBeTruthy();
    expect(caps.cpu.totalMemoryBytes).toBeGreaterThan(0);
    expect(Array.isArray(caps.gpu)).toBe(true);
    expect(caps.ffmpeg).toMatchObject({
      available: expect.any(Boolean),
      hardwareEncoders: expect.any(Array),
    });
    expect(caps.image).toMatchObject({ simd: expect.any(Boolean) });
    expect(caps.probedAt).toBeGreaterThan(0);
  });

  it("caches across calls unless { force: true }", async () => {
    const a = await probeHardware();
    const b = await probeHardware();
    expect(b.probedAt).toBe(a.probedAt);
    const c = await probeHardware({ force: true });
    expect(c.probedAt).toBeGreaterThanOrEqual(a.probedAt);
  });
});
