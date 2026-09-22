import { ApiError } from "./errors.js";
export async function workflowGateAssets(tx, workflowId, nodeKey) {
    const wf = await tx.workflowRun.findUniqueOrThrow({
        where: { id: workflowId },
        include: { nodes: true },
    });
    const input = wf.inputs;
    const result = (key) => (wf.nodes.find((n) => n.nodeKey === key)?.outputRef ?? {});
    const env = await tx.environment.findFirst({
        where: {
            id: input.environmentId,
            projectId: wf.projectId,
            isProduction: false,
            revision: input.environmentRevision,
        },
    });
    if (!env)
        throw new ApiError("CONFLICT", "环境已变化，请重新创建工作流");
    if (nodeKey === "rule_approval_gate") {
        const ids = result("rule_suggest").ruleVersionIds ?? input.ruleVersionIds ?? [];
        const rows = await tx.ruleVersion.findMany({
            where: {
                id: { in: ids },
                rule: { projectId: wf.projectId },
                reviewStatus: "APPROVED",
            },
        });
        if (!ids.length || rows.length !== ids.length)
            throw new ApiError("CONFLICT", "请先逐条审阅并批准本工作流的规则");
        const clarificationIds = result("rule_suggest").clarificationIds ?? [];
        if (clarificationIds.length) {
            const unresolved = await tx.clarification.count({
                where: { id: { in: clarificationIds }, resolvedAt: null },
            });
            if (unresolved)
                throw new ApiError("CONFLICT", "规则澄清尚未解决");
        }
        return { ruleVersionIds: ids };
    }
    const ids = result("case_suggest").caseVersionIds ?? input.caseVersionIds ?? [];
    const cases = await tx.testCaseVersion.findMany({
        where: {
            id: { in: ids },
            projectId: wf.projectId,
            approvalStatus: "APPROVED",
        },
        include: { plans: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!ids.length || cases.length !== ids.length)
        throw new ApiError("CONFLICT", "请先逐条审阅并批准本工作流的用例");
    if (Number(result("case_suggest").blockedRequirementCount ?? 0) > 0)
        throw new ApiError("CONFLICT", "生成结果存在未覆盖规则，请补齐需求后重新生成；不能忽略阻塞项");
    if (nodeKey === "case_approval_gate")
        return { caseVersionIds: ids };
    if (nodeKey !== "plan_proposal_gate")
        throw new ApiError("VALIDATION_ERROR", "不是人工批准节点");
    const pinnedPlans = [];
    for (const c of cases) {
        const frozen = input.pinnedPlans?.find((p) => p.caseVersionId === c.id);
        const p = frozen
            ? await tx.testPlanVersion.findUnique({
                where: { id: frozen.planVersionId },
            })
            : c.plans[0];
        if (!p ||
            p.caseVersionId !== c.id ||
            p.environmentId !== env.id ||
            p.environmentRevision !== env.revision)
            throw new ApiError("CONFLICT", "请先审阅并批准当前环境的全部执行计划");
        pinnedPlans.push({
            caseVersionId: c.id,
            planVersionId: p.id,
            acceptanceHash: p.acceptanceHash,
        });
    }
    return { caseVersionIds: ids, pinnedPlans };
}
//# sourceMappingURL=workflow-service.js.map