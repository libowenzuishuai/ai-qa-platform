import type { Prisma } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
/**
 * 运行创建 repository（阶段 1.1：R3/R4/R8/R9）。
 *
 * - R3 版本固定：创建时在事务中固定每个用例的 planVersionId 与
 *   acceptanceHash（casePlanPins）；worker 只按固定版本执行。
 * - R4 可信引用：逐项核验规则（存在/同项目/APPROVED）、规则来源
 *   （SourceSpan 存在且文档属于本项目）、基线成员、计划观察证据
 *   （Artifact 存在/同项目/类型 OBSERVATION/文件真实存在）。
 * - R8 并发幂等：唯一约束冲突后重读并按规范指纹比对（同体返回原 run，
 *   异体 409），绝不 500。
 * - R9 预算：解析并保存调用者预算（范围校验，超限拒绝）。
 */
export interface CreateRunInput {
    /** Internal retest path only: preserve the original plan versions. */
    pinnedPlans?: Array<{
        caseVersionId: string;
        planVersionId: string;
        acceptanceHash: string;
    }>;
    projectId: string;
    baselineId: string;
    environmentId: string;
    caseVersionIds: string[];
    buildId?: string | null;
    mode: "real" | "mock";
    idempotencyKey: string;
    budget?: {
        maxToolActionsPerCase?: number;
        maxWallClockMsPerCase?: number;
        maxWallClockMsPerRun?: number;
    };
}
export interface CreateRunResult {
    runId: string;
    existed: boolean;
}
export declare function createRun(prisma: import("@prisma/client").PrismaClient | Prisma.TransactionClient, store: ArtifactStore, input: CreateRunInput): Promise<CreateRunResult>;
