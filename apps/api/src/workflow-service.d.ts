import type { Prisma } from "@prisma/client";
type DB = Prisma.TransactionClient;
export type WorkflowInputs = {
    environmentId: string;
    environmentRevision: number;
    documentVersionIds: string[];
    baselineId?: string;
    buildId?: string;
    observationPages?: Array<{
        role: string;
        path: string;
    }>;
    caseVersionIds?: string[];
    ruleVersionIds?: string[];
    pinnedPlans?: Array<{
        caseVersionId: string;
        planVersionId: string;
        acceptanceHash: string;
    }>;
};
export declare function workflowGateAssets(tx: DB, workflowId: string, nodeKey: string): Promise<{
    ruleVersionIds: string[];
    caseVersionIds?: undefined;
    pinnedPlans?: undefined;
} | {
    caseVersionIds: string[];
    ruleVersionIds?: undefined;
    pinnedPlans?: undefined;
} | {
    caseVersionIds: string[];
    pinnedPlans: {
        caseVersionId: string;
        planVersionId: string;
        acceptanceHash: string;
    }[];
    ruleVersionIds?: undefined;
}>;
export {};
