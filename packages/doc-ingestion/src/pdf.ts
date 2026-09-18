import pdfParse from "pdf-parse";

export type PdfPageText = {
  page: number;
  text: string;
};

/**
 * 按 PDF 实际页提取文本（PRD FR-02 pdf-page 定位）。
 * 不使用行数估算页码。
 */
export async function extractPdfPages(data: Buffer): Promise<{ pages: PdfPageText[]; nPages: number }> {
  const pages: PdfPageText[] = [];
  let pageCounter = 0;

  const result = await pdfParse(data, {
    pagerender(pageData: {
      getTextContent: (opts?: object) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
    }) {
      const page = ++pageCounter;
      return pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      }).then((textContent) => {
        let lastY: number | undefined;
        let text = "";
        for (const item of textContent.items) {
          const y = item.transform[5];
          if (lastY === y || lastY === undefined) {
            text += item.str;
          } else {
            text += `\n${item.str}`;
          }
          lastY = y;
        }
        const trimmed = text.trim();
        pages.push({ page, text: trimmed });
        return trimmed;
      });
    },
  });

  return { pages, nPages: result.numpages };
}
