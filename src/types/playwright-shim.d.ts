// Ambient stub for the optional `playwright` peer dependency. Lets us
// `await import("playwright")` and `typeof import("playwright")` typecheck
// without actually installing the ~150MB package + Chromium binaries on
// dev machines. The runtime gracefully returns driver_missing when
// playwright is not present in the runner's node_modules.

declare module "playwright" {
  export interface PageMargin { top?: string; right?: string; bottom?: string; left?: string; }
  export interface PdfOptions {
    format?: string;
    printBackground?: boolean;
    margin?: PageMargin;
    displayHeaderFooter?: boolean;
    headerTemplate?: string;
    footerTemplate?: string;
  }
  export interface Page {
    setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
    pdf(opts?: PdfOptions): Promise<Buffer>;
  }
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface BrowserType {
    launch(opts?: unknown): Promise<Browser>;
  }
  export const chromium: BrowserType;
}
