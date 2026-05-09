// Ambient stub for dcmjs (no published types). We only need the surface
// that dicom-to-pdf actually consumes.

declare module "dcmjs" {
  export const data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer): { dict: Record<string, { Value?: unknown[] }> };
    };
    DicomMetaDictionary: {
      naturalizeDataset(dict: Record<string, { Value?: unknown[] }>): Record<string, unknown>;
    };
  };
}
