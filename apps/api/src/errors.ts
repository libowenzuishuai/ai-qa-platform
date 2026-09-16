import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApiErrorBody,
  DEFAULT_HTTP_STATUS_BY_CODE,
} from "@ai-qa/contracts";

/**
 * 统一 API 错误。错误体：{ code, message, requestId, details? }。
 * details 不得包含密钥、凭据或原始凭据引用。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly statusOverride?: number,
  ) {
    super(message);
  }
}

export function sendApiError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): void {
  const requestId = req.id;
  if (error instanceof ApiError) {
    const body = {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
    const parsed = ApiErrorBody.safeParse(body);
    if (!parsed.success) {
      req.log.error({ body }, "错误体不符合契约");
    }
    reply
      .code(error.statusOverride ?? DEFAULT_HTTP_STATUS_BY_CODE[code(error.code)] ?? 500)
      .send(body);
    return;
  }
  if (error instanceof z.ZodError) {
    reply.code(422).send({
      code: "VALIDATION_ERROR",
      message: "请求参数不符合契约",
      requestId,
      details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    } satisfies z.infer<typeof ApiErrorBody>);
    return;
  }
  req.log.error({ err: error }, "内部错误");
  reply.code(500).send({
    code: "INTERNAL",
    message: "内部错误，请查看服务端日志",
    requestId,
  } satisfies z.infer<typeof ApiErrorBody>);
}

function code(x: string): string {
  return x;
}
