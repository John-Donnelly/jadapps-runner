/**
 * ffmpeg hardware-encoder selection. Consults the host hardware probe and
 * picks the best available encoder for a given codec, falling back cleanly
 * to the software encoder when nothing accelerated is present.
 *
 * Built specifically for the runner's video-encoder built-in tools
 * (h265-encoder, av1-encoder, future h264-encoder). Audio tools don't
 * need this — there are no hardware-accelerated audio codecs in our
 * supported encoder set.
 */

import type { HardwareCaps, HardwareEncoder } from "./hardware.js";

export type VideoCodec = "h264" | "hevc" | "av1";

export type EncoderFamily =
  | "nvenc"
  | "qsv"
  | "amf"
  | "videotoolbox"
  | "vaapi"
  | "software";

export interface EncoderChoice {
  /** Value passed to ffmpeg's `-c:v` flag. */
  encoder: string;
  /** Provider family (or 'software' if we couldn't accelerate). */
  family: EncoderFamily;
  /** True iff `encoder` is a hardware-backed codec. */
  hardware: boolean;
  /**
   * Extra ffmpeg args the caller should append AFTER `-c:v <encoder>`.
   * Empty for software (caller already has its own preset/crf knobs).
   * For hardware encoders: codec-specific defaults that translate the
   * user's "medium quality, fast encode" intent into the right knobs
   * for that family (rate-control mode, quality preset, etc.).
   */
  extraArgs: string[];
}

/**
 * Per-codec preference order. Apple's VideoToolbox wins on macOS; on
 * Windows/Linux NVENC > QSV > AMF > VAAPI because that's roughly the
 * quality/availability order across the consumer install base. Order
 * here only matters when a host has multiple GPUs from different
 * vendors (e.g. NVIDIA discrete + Intel iGPU); we prefer the discrete.
 */
const HARDWARE_PRIORITY: Record<VideoCodec, readonly HardwareEncoder[]> = {
  h264: ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf", "h264_vaapi"],
  hevc: ["hevc_videotoolbox", "hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_vaapi"],
  av1: ["av1_nvenc", "av1_qsv", "av1_amf"],
};

const SOFTWARE_FALLBACK: Record<VideoCodec, string> = {
  h264: "libx264",
  hevc: "libx265",
  av1: "libsvtav1",
};

const FAMILY_FROM_ENCODER: Record<HardwareEncoder, EncoderFamily> = {
  h264_nvenc: "nvenc",
  hevc_nvenc: "nvenc",
  av1_nvenc: "nvenc",
  h264_qsv: "qsv",
  hevc_qsv: "qsv",
  av1_qsv: "qsv",
  h264_amf: "amf",
  hevc_amf: "amf",
  av1_amf: "amf",
  h264_videotoolbox: "videotoolbox",
  hevc_videotoolbox: "videotoolbox",
  h264_vaapi: "vaapi",
  hevc_vaapi: "vaapi",
};

/**
 * Choose the best ffmpeg encoder for a given codec on this host.
 *
 * Pass `{ preferSoftware: true }` to force the libx264 / libx265 / libsvtav1
 * path even on accelerated hosts (used by tests, debug flags, or quality-
 * critical workflows where users prefer the slower-but-better software
 * encoder).
 */
export function selectVideoEncoder(
  hw: Pick<HardwareCaps, "ffmpeg">,
  codec: VideoCodec,
  opts: { preferSoftware?: boolean } = {},
): EncoderChoice {
  if (opts.preferSoftware || !hw.ffmpeg.available) {
    return softwareChoice(codec);
  }
  for (const candidate of HARDWARE_PRIORITY[codec]) {
    if (hw.ffmpeg.hardwareEncoders.includes(candidate)) {
      return {
        encoder: candidate,
        family: FAMILY_FROM_ENCODER[candidate],
        hardware: true,
        extraArgs: hardwareExtras(candidate),
      };
    }
  }
  return softwareChoice(codec);
}

function softwareChoice(codec: VideoCodec): EncoderChoice {
  return {
    encoder: SOFTWARE_FALLBACK[codec],
    family: "software",
    hardware: false,
    extraArgs: [],
  };
}

/**
 * Codec-family-specific knobs that translate "the user picked medium-ish
 * quality" into the right rate-control settings for that hardware encoder.
 * The values are intentionally conservative — they produce a reasonable
 * file at a reasonable bitrate without tying the caller to a specific
 * quality target.
 *
 * Callers that pass an explicit bitrate (`-b:v`) should append it AFTER
 * these so it overrides the rate-control default.
 */
function hardwareExtras(encoder: HardwareEncoder): string[] {
  switch (FAMILY_FROM_ENCODER[encoder]) {
    case "nvenc":
      // p4 is "medium" on the new p1..p7 preset scale; cq=23 ≈ libx265 crf 23.
      return ["-preset", "p4", "-rc", "vbr", "-cq", "23"];
    case "qsv":
      return ["-preset", "medium", "-global_quality", "23"];
    case "amf":
      return ["-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "25"];
    case "videotoolbox":
      // VideoToolbox uses a 0..100 quality scale; 60 is a common "good enough".
      return ["-q:v", "60"];
    case "vaapi":
      return ["-qp", "23"];
    default:
      return [];
  }
}
