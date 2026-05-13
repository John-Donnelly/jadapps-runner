import { describe, expect, it } from "vitest";
import { selectVideoEncoder } from "../src/runtime/ffmpeg-encoder";
import type { HardwareCaps, HardwareEncoder } from "../src/runtime/hardware";

function fakeHw(over: Partial<HardwareCaps["ffmpeg"]> = {}): Pick<HardwareCaps, "ffmpeg"> {
  return {
    ffmpeg: { available: true, hardwareEncoders: [], ...over },
  };
}

describe("selectVideoEncoder", () => {
  it("falls back to software when ffmpeg is not available", () => {
    const out = selectVideoEncoder(
      { ffmpeg: { available: false, hardwareEncoders: [] } },
      "hevc",
    );
    expect(out).toEqual({
      encoder: "libx265",
      family: "software",
      hardware: false,
      extraArgs: [],
    });
  });

  it("falls back to software when no matching hardware encoder is present", () => {
    // av1_amf available but caller wants h264 — different codec.
    const out = selectVideoEncoder(
      fakeHw({ hardwareEncoders: ["av1_amf"] as HardwareEncoder[] }),
      "h264",
    );
    expect(out.family).toBe("software");
    expect(out.encoder).toBe("libx264");
  });

  it("prefers NVENC over QSV when both are present on x86 hosts", () => {
    const out = selectVideoEncoder(
      fakeHw({ hardwareEncoders: ["hevc_qsv", "hevc_nvenc"] }),
      "hevc",
    );
    expect(out.encoder).toBe("hevc_nvenc");
    expect(out.family).toBe("nvenc");
    expect(out.hardware).toBe(true);
  });

  it("picks VideoToolbox over NVENC when both are present (Apple Silicon priority)", () => {
    const out = selectVideoEncoder(
      fakeHw({
        hardwareEncoders: ["hevc_nvenc", "hevc_videotoolbox"],
      }),
      "hevc",
    );
    expect(out.encoder).toBe("hevc_videotoolbox");
    expect(out.family).toBe("videotoolbox");
  });

  it("emits codec-family-specific rate-control args for hardware encoders", () => {
    expect(
      selectVideoEncoder(fakeHw({ hardwareEncoders: ["hevc_nvenc"] }), "hevc").extraArgs,
    ).toEqual(["-preset", "p4", "-rc", "vbr", "-cq", "23"]);

    expect(
      selectVideoEncoder(fakeHw({ hardwareEncoders: ["h264_qsv"] }), "h264").extraArgs,
    ).toEqual(["-preset", "medium", "-global_quality", "23"]);

    expect(
      selectVideoEncoder(
        fakeHw({ hardwareEncoders: ["hevc_videotoolbox"] }),
        "hevc",
      ).extraArgs,
    ).toEqual(["-q:v", "60"]);

    expect(
      selectVideoEncoder(fakeHw({ hardwareEncoders: ["h264_amf"] }), "h264").extraArgs,
    ).toEqual([
      "-quality",
      "balanced",
      "-rc",
      "cqp",
      "-qp_i",
      "23",
      "-qp_p",
      "25",
    ]);
  });

  it("forces software when preferSoftware is set, even if hardware is available", () => {
    const out = selectVideoEncoder(
      fakeHw({ hardwareEncoders: ["hevc_nvenc"] }),
      "hevc",
      { preferSoftware: true },
    );
    expect(out.encoder).toBe("libx265");
    expect(out.family).toBe("software");
  });

  it("supports AV1 with the NVENC family", () => {
    const out = selectVideoEncoder(
      fakeHw({ hardwareEncoders: ["av1_nvenc"] }),
      "av1",
    );
    expect(out.encoder).toBe("av1_nvenc");
    expect(out.family).toBe("nvenc");
  });
});
