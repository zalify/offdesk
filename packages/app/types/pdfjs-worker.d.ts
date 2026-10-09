// The legacy worker bundle ships no types; only the module object is used (as
// pdf.js's main-thread "fake worker").
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
