import type { CatalogueEntry } from "../api/client.js";
import type { AccessToken, FileRef, ToolFamily, TierFamilyLimits } from "../types.js";

/**
 * Pre-flight per-family tier-limit checks. Mirrors the canonical
 * lib/tier-limits.ts behaviour on the runner side: every tool dispatch
 * resolves the tool's family, looks up `claims.familyLimits[family]`,
 * and checks the inputs against fileBytes / batchFiles ceilings before
 * touching the executor.
 *
 * Limits the runner enforces today (drawn from what TIER_LIMITS publishes):
 *   - fileBytes  — per-file ceiling, applies to every fileRef
 *   - batchFiles — number of files in a single dispatch
 *
 * Family-specific row/page/duration limits live in the browser code paths
 * because they require parsing the file contents. The runner wouldn't add
 * value duplicating that work — it just enforces the byte + count gates
 * the tool can't violate without us noticing.
 */

const SLUG_FAMILY_HINTS: Array<[RegExp, ToolFamily]> = [
  [/^csv-/, "csv"],
  [/^json-/, "json"],
  [/^pdf-/, "pdf"],
  [/^image-/, "image"],
  [/^audio-/, "audio"],
  [/^video-/, "video"],
  [/^markdown-|^md-/, "markdown"],
  [/^excel-/, "excel"],
  [/^security-|hash$|encrypt|redact/, "security"],
  [/^svg-/, "svg"],
  [/^3d-|mesh-/, "3d"],
  [/^font-/, "font"],
  [/^archive-|^zip-|^tar-/, "archive"],
];

/**
 * Best-effort family classifier. Catalogue entries don't currently carry
 * the family explicitly; fall back to slug pattern matching. Connector
 * slugs and unknown shapes return null — the pre-flight then skips the
 * limit check (better to over-allow than fail closed for unmapped tools).
 */
export function familyForCatalogueEntry(entry: CatalogueEntry): ToolFamily | null {
  for (const [re, family] of SLUG_FAMILY_HINTS) {
    if (re.test(entry.slug) || re.test(entry.toolId)) return family;
  }
  return null;
}

export interface TierLimitViolation {
  family: ToolFamily;
  type: "fileBytes" | "batchFiles";
  value: number;
  observed: number;
}

/**
 * Run the per-family checks. Returns the first violation, or null when
 * everything passes (or when `familyLimits` isn't on the access token —
 * older servers don't sign it, runner stays permissive).
 */
export function checkFamilyLimits(
  access: AccessToken,
  entry: CatalogueEntry,
  fileRefs: FileRef[],
): TierLimitViolation | null {
  const familyLimits = access.familyLimits;
  if (!familyLimits) return null;
  const family = familyForCatalogueEntry(entry);
  if (!family) return null;
  const limits = (familyLimits as TierFamilyLimits)[family];
  if (!limits) return null;

  if (typeof limits.batchFiles === "number" && fileRefs.length > limits.batchFiles) {
    return {
      family,
      type: "batchFiles",
      value: limits.batchFiles,
      observed: fileRefs.length,
    };
  }
  if (typeof limits.fileBytes === "number") {
    for (const ref of fileRefs) {
      if (ref.bytes > limits.fileBytes) {
        return {
          family,
          type: "fileBytes",
          value: limits.fileBytes,
          observed: ref.bytes,
        };
      }
    }
  }
  return null;
}

export function violationToHttpBody(v: TierLimitViolation): {
  error: string;
  limit: TierLimitViolation;
  upgrade_url: string;
} {
  return {
    error: "tier_limit_exceeded",
    limit: v,
    upgrade_url: "https://jadapps.app/pricing",
  };
}
