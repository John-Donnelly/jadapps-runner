import { describe, expect, it } from "vitest";
import { RUNNER_VERSION, buildHealthBody } from "../src/server/routes";
import type { HardwareCaps } from "../src/runtime/hardware";

function fakeHardware(over: Partial<HardwareCaps> = {}): HardwareCaps {
  return {
    cpu: {
      cores: 8,
      model: "Test CPU",
      arch: "x64",
      platform: "win32",
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    },
    gpu: [
      { name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", driverVersion: "1.0" },
    ],
    ffmpeg: {
      available: true,
      version: "7.0.2",
      hardwareEncoders: ["h264_nvenc", "hevc_nvenc"],
    },
    image: { simd: true, libvipsVersion: "8.15.3" },
    probedAt: Date.UTC(2026, 4, 13),
    ...over,
  };
}

describe("buildHealthBody", () => {
  it("returns ok=true with name, version, pid, queueDepth, and the hardware snapshot", () => {
    const hw = fakeHardware();
    const body = buildHealthBody(hw);
    expect(body.ok).toBe(true);
    expect(body.name).toBe("jadapps-runner");
    expect(body.version).toBe(RUNNER_VERSION);
    expect(body.pid).toBe(process.pid);
    expect(body.queueDepth).toBe(0);
    expect(body.hardware).toBe(hw);
  });

  it("preserves whatever hardware shape it's given (so the probe owns capability detection)", () => {
    const empty: HardwareCaps = {
      cpu: { cores: 1, model: "", arch: "", platform: "", totalMemoryBytes: 0 },
      gpu: [],
      ffmpeg: { available: false, hardwareEncoders: [] },
      image: { simd: false },
      probedAt: 0,
    };
    expect(buildHealthBody(empty).hardware).toBe(empty);
  });
});
