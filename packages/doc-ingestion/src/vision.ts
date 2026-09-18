import type { ModelResponse } from "@ai-qa/contracts";

/** 视觉模型输出：必须是非 null 对象且含非空 text 字符串。 */
export function extractVisionText(response: ModelResponse): string | null {
  if (response.outcome !== "SUCCESS") return null;
  const body = response.parsedJson;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 整图区域约定：归一化 bbox，供 image-region 定位。 */
export const WHOLE_IMAGE_BBOX: [number, number, number, number] = [0, 0, 1, 1];
