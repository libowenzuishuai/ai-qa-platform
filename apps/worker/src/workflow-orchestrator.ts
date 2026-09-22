import type { PrismaClient, Prisma } from "@prisma/client";
import { ArtifactStore } from "@ai-qa/artifact-store";
import {
  WORKFLOW_TEMPLATE_V1_NODES,
  EnvironmentRuntime,
  WorkflowBudget,
} from "@ai-qa/contracts";
import { emitWorkflowEvent, cancelWorkflowChildren } from "@ai-qa/run-events";
import { buildRunReport } from "@ai-qa/reporting";
import { createRun } from "../../api/src/runs-service.js";
import {
  workflowGateAssets,
  type WorkflowInputs,
} from "../../api/src/workflow-service.js";
import { loginFresh } from "../../api/src/preparation-service.js";

/** Each short transaction dispatches or polls durable children. No browser/model call holds a DB lock. */
export async function advanceWorkflow(
  prisma: PrismaClient,
  workflowId: string,
  store: ArtifactStore,
): Promise<void> {
  await prisma
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${workflowId} FOR UPDATE`;
        const wf = await tx.workflowRun.findUniqueOrThrow({
          where: { id: workflowId },
        });
        if (!wf || ["COMPLETED", "FAILED", "CANCELLED"].includes(wf.status))
          return;
        const budget = WorkflowBudget.parse(wf.budget),
          input = wf.inputs as WorkflowInputs;
        const deadline = wf.createdAt.getTime() + budget.maxWallClockMs;
        async function stop(message: string, nodeId?: string) {
          if (nodeId)
            await tx.workflowNode.update({
              where: { id: nodeId },
              data: {
                status: "failed",
                error: message,
                finishedAt: new Date(),
              },
            });
          await tx.workflowRun.update({
            where: { id: workflowId },
            data: { status: "FAILED", currentGate: null },
          });
          await cancelWorkflowChildren(tx, workflowId);
          await emitWorkflowEvent(tx, workflowId, "workflow.failed", {
            message,
          });
        }
        if (Date.now() >= deadline) {
          await stop("工作流时间预算已耗尽（包含等待人工确认）");
          return;
        }
        const env = await tx.environment.findFirst({
          where: {
            id: input.environmentId,
            projectId: wf.projectId,
            revision: input.environmentRevision,
            isProduction: false,
          },
        });
        if (!env) {
          await stop("环境配置发生变化，请重新创建工作流");
          return;
        }
        if (wf.status === "WAITING_HUMAN") {
          await tx.workflowRun.update({
            where: { id: workflowId },
            data: { updatedAt: new Date() },
          });
          return;
        }
        await tx.workflowRun.update({
          where: { id: workflowId },
          data: { status: "RUNNING" },
        });
        // R07：目录模板运行按冻结快照建节点（capabilityKey 驱动分发）；v1 固定链不变。
        const templateNodes = (input as WorkflowInputs & {
          templateNodes?: Array<{ key: string; capabilityKey: string; dependsOn?: string[]; isApprovalGate?: boolean; condition?: Record<string, unknown> }>;
        }).templateNodes;
        const nodeDefs: Array<{ key: string; capabilityKey?: string; condition?: Record<string, unknown> }> = templateNodes
          ? templateNodes.map((n) => ({ key: n.key, capabilityKey: n.capabilityKey, condition: n.condition }))
          : WORKFLOW_TEMPLATE_V1_NODES.map((key) => ({ key }));
        for (const [i, def] of nodeDefs.entries())
          await tx.workflowNode.upsert({
            where: { workflowId_nodeKey: { workflowId, nodeKey: def.key } },
            create: {
              workflowId,
              nodeKey: def.key,
              capabilityKey: def.capabilityKey ?? null,
              seq: i + 1,
              idempotencyKey: `${workflowId}:${def.key}`,
              inputHash: wf.inputFingerprint ?? workflowId,
            },
            update: {},
          });
        const nodes = await tx.workflowNode.findMany({
          where: { workflowId },
          orderBy: { seq: "asc" },
        });
        const node = nodes.find(
          (n) => !["completed", "skipped"].includes(n.status),
        );
        if (!node) {
          await tx.workflowRun.update({
            where: { id: workflowId },
            data: { status: "COMPLETED", currentGate: null },
          });
          await emitWorkflowEvent(tx, workflowId, "workflow.completed");
          return;
        }
        if (node.status === "failed") {
          await stop(node.error ?? "节点失败");
          return;
        }
        const ref = (node.outputRef ?? {}) as Record<string, any>;
        const output = (key: string) =>
          (nodes.find((n) => n.nodeKey === key)?.outputRef ?? {}) as Record<
            string,
            any
          >;
        async function complete(
          value: Record<string, unknown>,
          skipped = false,
        ) {
          await tx.workflowNode.update({
            where: { id: node!.id },
            data: {
              status: skipped ? "skipped" : "completed",
              outputRef: { ...ref, ...value } as Prisma.InputJsonValue,
              finishedAt: new Date(),
            },
          });
          await emitWorkflowEvent(tx, workflowId, "workflow.node_completed", {
            nodeKey: node!.nodeKey,
            output: value,
            skipped,
          });
        }
        async function waitHuman(
          description: string,
          value: Record<string, unknown> = {},
        ) {
          await tx.workflowNode.update({
            where: { id: node!.id },
            data: {
              status: "waiting_human",
              outputRef: { ...ref, ...value } as Prisma.InputJsonValue,
              humanTodo: {
                nodeId: node!.id,
                nodeKey: node!.nodeKey,
                description,
                createdAt: new Date().toISOString(),
              },
            },
          });
          await tx.workflowRun.update({
            where: { id: workflowId },
            data: { status: "WAITING_HUMAN", currentGate: node!.nodeKey },
          });
          await emitWorkflowEvent(tx, workflowId, "workflow.waiting_human", {
            nodeKey: node!.nodeKey,
            description,
            ...value,
          });
        }
        // Quotas are reserved durably before dispatch. Unused quota is deliberately not recycled.
        async function children(
          specs: Array<{ kind: string; request: Record<string, unknown> }>,
        ): Promise<any[] | null> {
          if (!ref.jobIds) {
            const usage = {
              toolCalls: 0,
              modelCallsReserved: 0,
              tokensReserved: 0,
              ...(wf.usage as object),
            };
            const jobIds: string[] = [];
            for (const spec of specs) {
              usage.toolCalls++;
              const model = [
                "DOCUMENT_PARSE",
                "RULE_EXTRACTION",
                "CASE_GENERATION",
                "PLAN_PROPOSAL",
              ].includes(spec.kind);
              const calls = model
                ? spec.kind === "DOCUMENT_PARSE"
                  ? Math.min(
                      16,
                      budget.maxModelCalls - usage.modelCallsReserved,
                    )
                  : 1
                : 0;
              const tokens = model
                ? Math.min(200000, budget.maxTokens - usage.tokensReserved)
                : 0;
              if (
                usage.toolCalls > budget.maxToolCalls ||
                (model && (calls < 1 || tokens < 1000))
              )
                throw new Error("工作流工具或模型预算不足");
              usage.modelCallsReserved += calls;
              usage.tokensReserved += tokens;
              const j = await tx.job.create({
                data: {
                  projectId: wf.projectId,
                  kind: spec.kind,
                  status: "QUEUED",
                  fingerprint: `${node!.id}:${jobIds.length}`,
                  request: {
                    ...spec.request,
                    workflowId,
                    workflowBudget: {
                      maxModelCalls: calls,
                      maxTokens: tokens,
                      deadline,
                    },
                  } as Prisma.InputJsonValue,
                },
              });
              jobIds.push(j.id);
              if (spec.kind === "LOGIN_CHECK")
                await tx.loginPreparation.update({
                  where: { id: String(spec.request.loginPreparationId) },
                  data: {
                    lastCheckJobId: j.id,
                    lastCheckStatus: "QUEUED",
                    lastCheckAt: null,
                  },
                });
            }
            await tx.workflowRun.update({
              where: { id: workflowId },
              data: { usage },
            });
            await tx.workflowNode.update({
              where: { id: node!.id },
              data: {
                outputRef: { ...ref, jobIds },
                toolCalls: specs.map((s, i) => ({
                  jobId: jobIds[i],
                  kind: s.kind,
                })) as Prisma.InputJsonValue,
              },
            });
            return null;
          }
          const jobs = await tx.job.findMany({
            where: { id: { in: ref.jobIds }, projectId: wf.projectId },
          });
          if (jobs.length !== ref.jobIds.length)
            throw new Error("子作业引用缺失");
          const failed = jobs.find((j) =>
            ["FAILED", "CANCELLED"].includes(j.status),
          );
          if (failed)
            throw new Error(
              `子作业 ${failed.kind} 未完成：${(failed.error as any)?.code ?? failed.status}，未自动重放`,
            );
          if (jobs.some((j) => j.status !== "SUCCEEDED")) return null;
          return ref.jobIds.map(
            (id: string) => jobs.find((j) => j.id === id)!.result,
          );
        }
        if (node.status === "queued") {
          await tx.workflowNode.update({
            where: { id: node.id },
            data: { status: "running", startedAt: new Date() },
          });
          await emitWorkflowEvent(tx, workflowId, "workflow.node_started", {
            nodeKey: node.nodeKey,
          });
        }
        const cases: string[] =
          output("case_suggest").caseVersionIds ?? input.caseVersionIds ?? [];
        const rules: string[] =
          output("rule_suggest").ruleVersionIds ?? input.ruleVersionIds ?? [];
        // 受限条件（不 eval）：变量指向 prior 节点输出或运行输入；不满足 → 跳过。
        const nodeCondition = templateNodes?.find((t) => t.key === node.nodeKey)?.condition;
        if (nodeCondition) {
          const cond = nodeCondition as { variable: string; operator: string; value?: unknown };
          const resolved = cond.variable.startsWith("input.")
            ? (input as Record<string, unknown>)[cond.variable.slice(6)]
            : cond.variable.split(".").reduce<unknown>((acc, part) =>
                (acc as Record<string, unknown> | undefined)?.[part], {
                  outputs: Object.fromEntries(
                    nodes
                      .filter((n) => n.status === "completed")
                      .map((n) => [n.capabilityKey ?? n.nodeKey, n.outputRef ?? {}]),
                  ),
                });
          let met = false;
          if (cond.operator === "exists") met = resolved !== undefined && resolved !== null;
          else if (cond.operator === "not_exists") met = resolved === undefined || resolved === null;
          else if (cond.operator === "eq") met = resolved === cond.value;
          else if (cond.operator === "ne") met = resolved !== cond.value;
          else if (cond.operator === "gt") met = Number(resolved) > Number(cond.value);
          else if (cond.operator === "lt") met = Number(resolved) < Number(cond.value);
          else throw new Error(`不支持的条件运算符：${cond.operator}`);
          if (!met) {
            await complete({ skippedByCondition: cond }, true);
            return;
          }
        }
        const CAPABILITY_HANDLERS: Record<string, string> = {
          "document-parse": "document_parse",
          "rule-extract": "rule_suggest",
          "rule-approval-gate": "rule_approval_gate",
          "case-generate": "case_suggest",
          "case-approval-gate": "case_approval_gate",
          "page-observe": "page_observation",
          "plan-approval-gate": "plan_proposal_gate",
          "login-check": "preparation_check",
          "browser-execute": "execution",
          "evaluate": "evaluation",
          "repo-discovery": "repo_discovery",
        };
        const dispatchKey = node.capabilityKey
          ? CAPABILITY_HANDLERS[node.capabilityKey]
          : node.nodeKey;
        if (node.capabilityKey && !dispatchKey)
          throw new Error(`节点 ${node.nodeKey} 引用了未注册的执行能力：${node.capabilityKey}`);
        try {
          switch (dispatchKey) {
            case "document_parse": {
              if (input.baselineId) {
                await complete(
                  { reason: "使用已批准基线，无需重新解析" },
                  true,
                );
                break;
              }
              // Uploaded documents may already have a parser job; never launch a second parser
              // that would replace SourceSpan IDs referenced by approved rules.
              if (!ref.jobIds) {
                await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id = ANY(${input.documentVersionIds}::text[]) ORDER BY id FOR UPDATE`;
                const docs = await tx.documentVersion.findMany({
                  where: {
                    id: { in: input.documentVersionIds },
                    document: { projectId: wf.projectId },
                  },
                });
                if (docs.length !== input.documentVersionIds.length)
                  throw new Error("资料版本缺失");
                if (docs.every((d) => d.parseStatus === "PARSED")) {
                  await complete(
                    { documentVersionIds: input.documentVersionIds },
                    true,
                  );
                  break;
                }
                const outstanding = await tx.job.findMany({
                  where: {
                    projectId: wf.projectId,
                    kind: "DOCUMENT_PARSE",
                    status: { in: ["QUEUED", "RUNNING"] },
                  },
                });
                const dependencies = outstanding.filter((j) =>
                  input.documentVersionIds.includes(
                    (j.request as any).documentVersionId,
                  ),
                );
                if (dependencies.length) {
                  await tx.workflowNode.update({
                    where: { id: node.id },
                    data: {
                      outputRef: {
                        dependencyJobIds: dependencies.map((j) => j.id),
                      },
                    },
                  });
                  break;
                }
                if (
                  docs.some((d) =>
                    ["FAILED", "NEEDS_OCR"].includes(d.parseStatus),
                  )
                )
                  throw new Error("资料解析未完成，请先处理解析问题");
                const result = await children(
                  docs
                    .filter((d) => d.parseStatus !== "PARSED")
                    .map((d) => ({
                      kind: "DOCUMENT_PARSE",
                      request: { documentVersionId: d.id, mode: "real" },
                    })),
                );
                if (result)
                  await complete({
                    documentVersionIds: input.documentVersionIds,
                  });
              } else {
                const result = await children([]);
                if (result) {
                  if (result.some((r) => r.parseStatus !== "PARSED"))
                    throw new Error("资料仍有未解析内容");
                  await complete({
                    documentVersionIds: input.documentVersionIds,
                  });
                }
              }
              break;
            }
            case "repo_discovery": {
              // 工程体检入口：真实仓库发现（凭据与范围由准备中心固定）。
              const r = await children([
                {
                  kind: "REPO_DISCOVERY",
                  request: { repositoryUrl: input.repositoryUrl ?? "", subdirectory: input.subdirectory ?? "", mode: "real" },
                },
              ]);
              if (r) await complete(r[0] ?? {});
              break;
            }
            case "rule_suggest": {
              if (input.baselineId) {
                await complete({ ruleVersionIds: input.ruleVersionIds }, true);
                break;
              }
              const r = await children([
                {
                  kind: "RULE_EXTRACTION",
                  request: {
                    documentVersionIds: input.documentVersionIds,
                    glossaryUpdates: [],
                    mode: "real",
                  },
                },
              ]);
              if (r) {
                if (!r[0].ruleVersionIds.length)
                  throw new Error("没有可审阅规则");
                await complete(r[0]);
              }
              break;
            }
            case "rule_approval_gate":
            case "case_approval_gate": {
              if (input.baselineId) {
                await complete(
                  await workflowGateAssets(tx, workflowId, node.nodeKey),
                  true,
                );
                break;
              }
              await waitHuman(
                node.nodeKey === "rule_approval_gate"
                  ? "请逐条批准规则并解决澄清后确认"
                  : "请逐条批准用例并核对覆盖后确认",
                { ruleVersionIds: rules, caseVersionIds: cases },
              );
              break;
            }
            case "case_suggest": {
              if (input.baselineId) {
                await complete({ caseVersionIds: input.caseVersionIds }, true);
                break;
              }
              const r = await children([
                {
                  kind: "CASE_GENERATION",
                  request: { ruleVersionIds: rules, mode: "real" },
                },
              ]);
              if (r) await complete(r[0]);
              break;
            }
            case "page_observation": {
              if (input.pinnedPlans?.length === cases.length && cases.length) {
                await complete({ reason: "复用创建时固定的已批准计划" }, true);
                break;
              }
              if (!input.observationPages?.length)
                throw new Error(
                  "缺少明确的观察页面，请指定角色和相对路径后重新创建",
                );
              const r = await children([
                {
                  kind: "WEB_OBSERVATION",
                  request: {
                    environmentId: env.id,
                    pages: input.observationPages,
                    allowWrites: false,
                  },
                },
              ]);
              if (r) await complete(r[0]);
              break;
            }
            case "plan_proposal_gate": {
              if (input.pinnedPlans?.length === cases.length && cases.length) {
                await complete(
                  await workflowGateAssets(tx, workflowId, node.nodeKey),
                  true,
                );
                break;
              }
              const r = await children(
                cases.map((caseVersionId) => ({
                  kind: "PLAN_PROPOSAL",
                  request: {
                    caseVersionId,
                    observationId: output("page_observation").artifactId,
                    mode: "real",
                  },
                })),
              );
              if (r)
                await waitHuman("请审阅候选执行计划，逐一批准后确认", {
                  proposalIds: r.map((x) => x.proposalId),
                });
              break;
            }
            case "preparation_check": {
              const runtime = EnvironmentRuntime.parse(env.runtime);
              const rows = await tx.testCaseVersion.findMany({
                where: { id: { in: cases }, projectId: wf.projectId },
              });
              const required = [
                ...new Set(
                  rows
                    .flatMap((c) => c.roles)
                    .filter((role) => runtime.secretRefs[role]),
                ),
              ];
              const checks = [];
              for (const role of required) {
                const prep = await tx.loginPreparation.findFirst({
                  where: {
                    environmentId: env.id,
                    role,
                    projectId: wf.projectId,
                  },
                });
                if (!prep?.configuration)
                  throw new Error(
                    `角色 ${role} 尚未配置登录检查，请在准备中心配置`,
                  );
                if (!loginFresh(prep, env.revision))
                  checks.push({
                    kind: "LOGIN_CHECK",
                    request: {
                      loginPreparationId: prep.id,
                      configuration: prep.configuration,
                      configHash: prep.configHash,
                      environmentId: env.id,
                      environmentRevision: env.revision,
                    },
                  });
              }
              if (checks.length || ref.jobIds) {
                const results = await children(checks);
                if (!results) break;
                if (results.some((r) => r.result.status !== "PASS"))
                  throw new Error("登录准备检查未通过，请查看检查结果");
              }
              const pending = await tx.dataResource.count({
                where: {
                  projectId: wf.projectId,
                  runId: null,
                  status: {
                    in: ["pending", "unknown", "cleaning", "cleanup_failed"],
                  },
                },
              });
              await complete({
                checkedRoleCount: required.length,
                residualResourceCount: pending,
              });
              break;
            }
            case "execution": {
              if (!ref.runId) {
                const approved = output("plan_proposal_gate");
                let baselineId = input.baselineId;
                if (!baselineId) {
                  const baseline = await tx.baseline.create({
                    data: {
                      projectId: wf.projectId,
                      name: `工作流 ${workflowId}`,
                      caseVersionIds: cases,
                      ruleVersionIds: rules,
                    },
                  });
                  baselineId = baseline.id;
                }
                const remainingTools =
                  budget.maxToolCalls -
                  Number((wf.usage as any).toolCalls ?? 0);
                if (remainingTools < cases.length)
                  throw new Error("执行工具预算不足");
                const remaining = deadline - Date.now();
                if (remaining < 60000)
                  throw new Error("执行剩余时间不足一分钟");
                const run = await createRun(tx, store, {
                  projectId: wf.projectId,
                  baselineId,
                  environmentId: env.id,
                  caseVersionIds: cases,
                  pinnedPlans: approved.pinnedPlans,
                  buildId: input.buildId,
                  mode: "real",
                  idempotencyKey: `workflow-${workflowId}`,
                  budget: {
                    maxWallClockMsPerRun: Math.min(remaining, 7200000),
                    maxToolActionsPerCase: Math.min(
                      1000,
                      Math.max(1, Math.floor(remainingTools / cases.length)),
                    ),
                  },
                });
                await tx.workflowRun.update({
                  where: { id: workflowId },
                  data: {
                    usage: {
                      ...(wf.usage as object),
                      toolCalls: budget.maxToolCalls,
                      executionActionsReserved: remainingTools,
                    },
                  },
                });
                await tx.workflowNode.update({
                  where: { id: node.id },
                  data: {
                    outputRef: { runId: run.runId },
                    toolCalls: [{ runId: run.runId, kind: "RUN" }],
                  },
                });
              } else {
                const run = await tx.run.findFirstOrThrow({
                  where: { id: ref.runId, projectId: wf.projectId },
                });
                if (["ERROR", "CANCELLED"].includes(run.lifecycle))
                  throw new Error(`执行终止：${run.lifecycle}`);
                if (run.lifecycle === "FINISHED")
                  await complete({ runId: run.id });
              }
              break;
            }
            case "evaluation": {
              const runId = output("execution").runId;
              // Reporting re-reads artifacts and computes the same verdict as the public report.
              const report = await buildRunReport(
                tx as unknown as PrismaClient,
                store,
                runId,
              );
              await complete({
                runId,
                acceptanceStatus: report.run.acceptanceStatus,
                reportUrl: `/api/runs/${runId}/report`,
              });
              break;
            }
            default:
              throw new Error("未知工作流节点");
          }
        } catch (err) {
          await stop(
            err instanceof Error ? err.message.slice(0, 500) : "节点执行失败",
            node.id,
          );
        }
      },
      { timeout: 30000 },
    )
    .catch(async () => {
      // A DB constraint/transaction failure must not leave a running workflow forever.
      // The original transaction rolled back, so only committed child receipts are cancelled.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${workflowId} FOR UPDATE`;
        const changed = await tx.workflowRun.updateMany({
          where: {
            id: workflowId,
            status: { in: ["QUEUED", "RUNNING", "WAITING_HUMAN"] },
          },
          data: { status: "FAILED", currentGate: null },
        });
        if (changed.count) {
          await cancelWorkflowChildren(tx, workflowId);
          await emitWorkflowEvent(tx, workflowId, "workflow.failed", {
            message: "工作流持久化失败，已停止；请检查服务状态后新建工作流",
          });
        }
      });
    });
}
