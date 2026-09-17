/**
 * 运行事件与生命周期原语 —— 统一来自共享包 @ai-qa/run-events（R2/R7）。
 * 本地不再维护独立实现，避免 API 与 worker 序号分配/迁移语义漂移。
 */
export {
  allocateEventSeq,
  emitRunEvent,
  casTransitionRun,
  currentLifecycle,
  isRunActive,
  parseRedisConnection,
  RUN_LIFECYCLE_TRANSITIONS,
  ACTIVE_LIFECYCLE,
  NON_TERMINAL_LIFECYCLE,
  TERMINAL_LIFECYCLE,
} from "@ai-qa/run-events";
