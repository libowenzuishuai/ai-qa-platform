import pdfParse from "pdf-parse";

/** 从 PDF 缓冲区提取文本；无文本层返回空字符串。 */
export async function extractPdfText(data: Buffer): Promise<{ text: string; nPages: number }> {
  const result = await pdfParse(data);
  return { text: result.text ?? "", nPages: result.numpages ?? 0 };
}
