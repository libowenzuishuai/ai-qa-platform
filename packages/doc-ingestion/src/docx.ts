import mammoth from "mammoth";

/** DOCX → 纯文本（段落以换行分隔）。 */
export async function extractDocxText(data: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: data });
  return result.value ?? "";
}
