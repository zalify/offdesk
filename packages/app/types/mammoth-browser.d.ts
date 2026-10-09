// The browser bundle ships no types of its own; this is the one call we use.
declare module "mammoth/mammoth.browser.min.js" {
  interface Mammoth {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{
      value: string;
      messages: unknown[];
    }>;
  }
  const mammoth: Mammoth;
  export default mammoth;
  export const convertToHtml: Mammoth["convertToHtml"];
}
