import { describe, expect, it } from "vitest";
import { chromiumGpuArgs } from "../src/runtime/browser-worker";
import type { HardwareCaps } from "../src/runtime/hardware";

function hw(over: Partial<HardwareCaps> = {}): HardwareCaps {
  return {
    cpu: { cores: 8, model: "x", arch: "x64", platform: "win32", totalMemoryBytes: 0 },
    gpu: [],
    ffmpeg: { available: false, hardwareEncoders: [] },
    image: { simd: true },
    probedAt: 0,
    ...over,
  };
}

describe("chromiumGpuArgs", () => {
  it("returns an empty arg list when no GPU is detected (let Chromium fall back to SwiftShader)", () => {
    expect(chromiumGpuArgs(hw({ gpu: [] }), "win32")).toEqual([]);
    expect(chromiumGpuArgs(hw({ gpu: [] }), "darwin")).toEqual([]);
    expect(chromiumGpuArgs(hw({ gpu: [] }), "linux")).toEqual([]);
  });

  it("enables WebGPU and the platform-appropriate ANGLE backend on Windows", () => {
    const args = chromiumGpuArgs(
      hw({ gpu: [{ name: "NVIDIA RTX 4090", vendor: "nvidia" }] }),
      "win32",
    );
    expect(args).toContain("--enable-unsafe-webgpu");
    expect(args).toContain("--enable-features=Vulkan,WebGPU");
    expect(args).toContain("--use-angle=d3d11");
  });

  it("uses Metal on macOS", () => {
    const args = chromiumGpuArgs(
      hw({ gpu: [{ name: "Apple M2 Max", vendor: "apple" }] }),
      "darwin",
    );
    expect(args).toContain("--use-angle=metal");
    expect(args).not.toContain("--use-angle=d3d11");
  });

  it("uses Vulkan on Linux", () => {
    const args = chromiumGpuArgs(
      hw({ gpu: [{ name: "Intel UHD", vendor: "intel" }] }),
      "linux",
    );
    expect(args).toContain("--use-angle=vulkan");
  });

  it("omits the ANGLE flag on unsupported platforms but still enables WebGPU", () => {
    const args = chromiumGpuArgs(
      hw({ gpu: [{ name: "Some GPU", vendor: "other" }] }),
      "freebsd",
    );
    expect(args).toContain("--enable-unsafe-webgpu");
    expect(args.find((a) => a.startsWith("--use-angle="))).toBeUndefined();
  });
});
