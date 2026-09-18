/**
 * 适配器错误（对齐 contracts ApiErrorBody 形状）。
 * 上层（API/worker）可直接把 code/message/details 透传为统一错误体。
 */
export class ModelError extends Error {
  constructor(
    public readonly code:
      | "MODEL_NOT_CONFIGURED"
      | "MODEL_OUTPUT_INVALID"
      | "MODEL_TIMEOUT"
      | "DEPENDENCY_UNAVAILABLE",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ModelError";
  }
}
