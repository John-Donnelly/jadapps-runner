import { describe, it, expect } from "vitest";
import {
  checkFamilyLimits,
  familyForCatalogueEntry,
  violationToHttpBody,
} from "../src/runtime/tier-limits";
import type { AccessToken, FileRef } from "../src/types";
import type { CatalogueEntry } from "../src/api/client";

function entry(over: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    slug: "csv-cleaner",
    toolId: "csv-cleaner",
    version: "1.0.0",
    runtime: "runner-local",
    tierRequired: "free",
    bundleUrl: "https://example.com/b.json",
    bundleSha256: "0".repeat(64),
    encrypted: false,
    ...over,
  };
}

function file(bytes: number, name = "x.csv"): FileRef {
  return {
    ref: `r-${bytes}`,
    bytes,
    sha256: "0".repeat(64),
    mime: "text/csv",
    filename: name,
  };
}

function access(over: Partial<AccessToken> = {}): AccessToken {
  return {
    jwt: "stub.jwt.value",
    expiresAt: Date.now() + 60_000,
    sub: "alice@example.com",
    tier: "pro",
    limits: {
      maxBytesPerRun: 100 * 1024 * 1024,
      maxConcurrentRuns: 4,
      monthlyByteBudget: 0,
    },
    ...over,
  };
}

describe("familyForCatalogueEntry", () => {
  it("classifies CSV slugs as csv", () => {
    expect(familyForCatalogueEntry(entry({ slug: "csv-cleaner" }))).toBe("csv");
  });
  it("classifies image slugs as image", () => {
    expect(
      familyForCatalogueEntry(
        entry({ slug: "image-converter", toolId: "image-converter" }),
      ),
    ).toBe("image");
  });
  it("returns null for unknown shapes (connectors etc.)", () => {
    expect(
      familyForCatalogueEntry(
        entry({ slug: "slack-postmessage", toolId: "slack-postmessage" }),
      ),
    ).toBeNull();
  });
});

describe("checkFamilyLimits", () => {
  it("skips when familyLimits is missing on the access token", () => {
    const v = checkFamilyLimits(access(), entry({ slug: "csv-cleaner" }), [
      file(999_999_999),
    ]);
    expect(v).toBeNull();
  });

  it("skips when family is unknown (connector / unmapped slug)", () => {
    const v = checkFamilyLimits(
      access({ familyLimits: { csv: { fileBytes: 1024 } } }),
      entry({ slug: "slack-postmessage", toolId: "slack-postmessage" }),
      [file(2048)],
    );
    expect(v).toBeNull();
  });

  it("flags fileBytes when one file exceeds the cap", () => {
    const v = checkFamilyLimits(
      access({ familyLimits: { csv: { fileBytes: 1024 } } }),
      entry({ slug: "csv-cleaner" }),
      [file(2048)],
    );
    expect(v).toEqual({
      family: "csv",
      type: "fileBytes",
      value: 1024,
      observed: 2048,
    });
  });

  it("flags batchFiles before fileBytes when both fail", () => {
    const v = checkFamilyLimits(
      access({ familyLimits: { csv: { fileBytes: 1024, batchFiles: 1 } } }),
      entry({ slug: "csv-cleaner" }),
      [file(2048), file(2048)],
    );
    expect(v?.type).toBe("batchFiles");
    expect(v?.value).toBe(1);
  });

  it("passes when limits exist but inputs fit", () => {
    const v = checkFamilyLimits(
      access({
        familyLimits: { csv: { fileBytes: 5_000_000, batchFiles: 10 } },
      }),
      entry({ slug: "csv-cleaner" }),
      [file(1024)],
    );
    expect(v).toBeNull();
  });

  it("ignores empty file lists when only fileBytes is set", () => {
    const v = checkFamilyLimits(
      access({ familyLimits: { csv: { fileBytes: 1024 } } }),
      entry({ slug: "csv-cleaner" }),
      [],
    );
    expect(v).toBeNull();
  });
});

describe("violationToHttpBody", () => {
  it("wraps the violation under the canonical 429 envelope", () => {
    const body = violationToHttpBody({
      family: "csv",
      type: "fileBytes",
      value: 1024,
      observed: 2048,
    });
    expect(body.error).toBe("tier_limit_exceeded");
    expect(body.upgrade_url).toBe("https://jadapps.app/pricing");
    expect(body.limit.observed).toBe(2048);
  });
});
