import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";

/**
 * v2 远程适配器协议（HAR-01：remote-http）。
 * TS 执行器 → 远程适配器进程（Python 或任意实现）的信封与结果。
 * 结果形状与 TS CapabilityAdapter 返回一致；输出在执行器侧再校验
 * （远端不可信，不能因它自称 SUCCEEDED 就采信）。
 */

export const CapabilityRpcEnvelope = z.object({
  protocolVersion: z.literal("aiqa.capability-rpc/2"),
  invocationId: EntityId,
  /** 绝对截止时间（ISO；远端超时后不得提交新副作用）。 */
  deadline: IsoDateTime,
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type CapabilityRpcEnvelope = z.infer<typeof CapabilityRpcEnvelope>;

export const RemoteExecuteRequest = z.object({
  envelope: CapabilityRpcEnvelope,
  input: z.unknown(),
}).strict();
export type RemoteExecuteRequest = z.infer<typeof RemoteExecuteRequest>;

export const RemoteCapabilityResult = z.object({
  status: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
  output: z.unknown().nullable(),
  resourceKeys: z.array(z.string().min(1).max(300)).max(100).default([]),
  retryable: z.boolean().default(false),
  error: z.object({ code: z.string().max(100), message: z.string().max(2000) }).nullable().default(null),
}).strict();
export type RemoteCapabilityResult = z.infer<typeof RemoteCapabilityResult>;
