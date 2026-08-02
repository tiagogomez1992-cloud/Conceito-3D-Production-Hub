declare module "tesseract.js" {
  export function createWorker(language: string, oem: number, options: { langPath: string; cacheMethod?: "none" | "write" | "readOnly" | "refresh" }): Promise<{
    recognize(image: string): Promise<{ data: { text: string } }>;
    terminate(): Promise<void>;
  }>;
}
