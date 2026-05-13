import { describe, expect, it } from "vitest";
import { normalizeEdge, normalizeGraph, normalizeNode } from "../src/mcp/tools/workflow";

describe("normalizeNode", () => {
  it("rewrites a canonical node verbatim", () => {
    const out = normalizeNode(
      {
        id: "n1",
        toolSlug: "csv-cleaner",
        position: { x: 100, y: 200 },
        config: { trimWhitespace: true },
      },
      0,
    );
    expect(out).toEqual({
      id: "n1",
      toolSlug: "csv-cleaner",
      position: { x: 100, y: 200 },
      config: { trimWhitespace: true },
    });
  });

  it("auto-generates id when missing", () => {
    const out = normalizeNode({ toolSlug: "csv-cleaner" }, 0);
    expect(out.id).toMatch(/^n_[a-f0-9]+$/);
    expect(out.toolSlug).toBe("csv-cleaner");
  });

  it("auto-lays-out position horizontally when missing", () => {
    const a = normalizeNode({ toolSlug: "csv-cleaner" }, 0);
    const b = normalizeNode({ toolSlug: "csv-to-json" }, 1);
    const c = normalizeNode({ toolSlug: "csv-validator" }, 2);
    expect(a.position).toEqual({ x: 200, y: 200 });
    expect(b.position).toEqual({ x: 440, y: 200 });
    expect(c.position).toEqual({ x: 680, y: 200 });
  });

  it("defaults config to empty object", () => {
    const out = normalizeNode({ toolSlug: "csv-cleaner" }, 0);
    expect(out.config).toEqual({});
  });

  it("accepts 'tool' as an alias for toolSlug", () => {
    const out = normalizeNode({ id: "n1", tool: "csv-cleaner" }, 0);
    expect(out.toolSlug).toBe("csv-cleaner");
  });

  it("accepts 'slug' as an alias for toolSlug", () => {
    const out = normalizeNode({ id: "n1", slug: "csv-cleaner" }, 0);
    expect(out.toolSlug).toBe("csv-cleaner");
  });

  it("preserves label/category/errorPolicy/logicKind when supplied", () => {
    const out = normalizeNode(
      {
        toolSlug: "csv-cleaner",
        label: "Clean Step",
        category: "csv",
        errorPolicy: "retry",
        logicKind: "if-else",
      },
      0,
    );
    expect(out.label).toBe("Clean Step");
    expect(out.category).toBe("csv");
    expect(out.errorPolicy).toBe("retry");
    expect(out.logicKind).toBe("if-else");
  });

  it("accepts 'name'/'title' as label aliases", () => {
    const a = normalizeNode({ toolSlug: "x", name: "Step 1" }, 0);
    const b = normalizeNode({ toolSlug: "y", title: "Step 2" }, 0);
    expect(a.label).toBe("Step 1");
    expect(b.label).toBe("Step 2");
  });

  it("rejects nodes missing toolSlug with a useful message", () => {
    expect(() => normalizeNode({ id: "csv-cleaner", name: "Clean" }, 0)).toThrow(
      /node at index 0 is missing toolSlug/,
    );
  });

  it("rejects non-object inputs", () => {
    expect(() => normalizeNode("a string", 0)).toThrow(/not an object/);
    expect(() => normalizeNode(null, 1)).toThrow(/not an object/);
    expect(() => normalizeNode([1, 2], 2)).toThrow(/not an object/);
  });
});

describe("normalizeEdge", () => {
  it("rewrites a canonical edge verbatim", () => {
    const out = normalizeEdge(
      {
        id: "e1",
        source: "n1",
        target: "n2",
        sourcePort: "csv-out",
        targetPort: "csv-in",
      },
      0,
    );
    expect(out).toEqual({
      id: "e1",
      source: "n1",
      target: "n2",
      sourcePort: "csv-out",
      targetPort: "csv-in",
    });
  });

  it("accepts 'from'/'to' as aliases for source/target", () => {
    const out = normalizeEdge({ from: "n1", to: "n2" }, 0);
    expect(out.source).toBe("n1");
    expect(out.target).toBe("n2");
  });

  it("defaults ports to empty strings", () => {
    const out = normalizeEdge({ source: "n1", target: "n2" }, 0);
    expect(out.sourcePort).toBe("");
    expect(out.targetPort).toBe("");
  });

  it("auto-generates id when missing", () => {
    const out = normalizeEdge({ source: "n1", target: "n2" }, 0);
    expect(out.id).toMatch(/^e_[a-f0-9]+$/);
  });

  it("rejects edges missing source/target", () => {
    expect(() => normalizeEdge({ target: "n2" }, 0)).toThrow(/missing source\/target/);
    expect(() => normalizeEdge({ source: "n1" }, 0)).toThrow(/missing source\/target/);
  });
});

describe("normalizeGraph", () => {
  it("regression: rejects Gemma 4 e2b's exact bad workflow_create graph", () => {
    // This is verbatim what the user's Gemma model produced. The old loose
    // schema accepted it and the dashboard canvas couldn't load it.
    const gemma = {
      nodes: [
        { id: "csv-cleaner", name: "Clean CSV Data" },
        { id: "csv-to-json", name: "Convert to JSON" },
      ],
      edges: [{ from: "csv-cleaner", to: "csv-to-json" }],
    };
    // Each node uses its TOOL slug as the node `id` and has no toolSlug field.
    // The new normalizer surfaces a clear error rather than silently saving.
    expect(() => normalizeGraph(gemma)).toThrow(/missing toolSlug/);
  });

  it("normalises a minimal-but-valid graph end-to-end", () => {
    const result = normalizeGraph({
      nodes: [{ toolSlug: "csv-cleaner" }, { toolSlug: "csv-to-json" }],
      edges: [{ from: "$0", to: "$1" }],
    });
    // ids auto-generated, positions auto-laid out, config defaults to {}.
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.toolSlug).toBe("csv-cleaner");
    expect(result.nodes[1]?.toolSlug).toBe("csv-to-json");
    expect(result.nodes[0]?.position).toEqual({ x: 200, y: 200 });
    expect(result.nodes[1]?.position).toEqual({ x: 440, y: 200 });
    expect(result.nodes[0]?.config).toEqual({});
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.source).toBe("$0");
    expect(result.edges[0]?.target).toBe("$1");
    expect(result.edges[0]?.sourcePort).toBe("");
  });

  it("accepts the canonical-but-explicit shape unchanged in semantics", () => {
    const result = normalizeGraph({
      nodes: [
        { id: "n1", toolSlug: "csv-cleaner", position: { x: 100, y: 100 }, config: { a: 1 } },
        { id: "n2", toolSlug: "csv-to-json", position: { x: 400, y: 100 }, config: {} },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", sourcePort: "csv-out", targetPort: "csv-in" },
      ],
    });
    expect(result.nodes[0]?.id).toBe("n1");
    expect(result.nodes[1]?.position).toEqual({ x: 400, y: 100 });
    expect(result.edges[0]?.sourcePort).toBe("csv-out");
  });

  it("propagates a node index in the error when one node is bad", () => {
    expect(() =>
      normalizeGraph({
        nodes: [{ toolSlug: "csv-cleaner" }, { name: "broken" }],
        edges: [],
      }),
    ).toThrow(/node at index 1 is missing toolSlug/);
  });
});
