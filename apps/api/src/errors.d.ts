import type { FastifyReply, FastifyRequest } from "fastify";
/**
 * 统一 API 错误。错误体：{ code, message, requestId, details? }。
 * details 不得包含密钥、凭据或原始凭据引用。
 */
export declare class ApiError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    readonly statusOverride?: number | undefined;
    constructor(code: string, message: string, details?: unknown | undefined, statusOverride?: number | undefined);
}
export declare function sendApiError(req: FastifyRequest, reply: FastifyReply, error: unknown): void;
