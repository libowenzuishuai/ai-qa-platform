import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import { TestCaseVersion, verifyStoredPlan } from "@ai-qa/contracts";
import { aggregateRun, percent } from "@ai-qa/evaluation";

/**
 * 运行报告构建（评审 R5）。
 *
 * 唯一口径：worker 终态聚合与 API 报告接口共用本模块，详情页的
 * acceptanceStatus 与报告的 metrics 必然一致。
 *
 * 证据完整性（对照固定计划，而不是只遍历已有结果记录）：
 * - 运行固定的每个用例计划（casePlanPins；旧运行回退最新计划版本）
 *   中所有 required 断言必须有本次 attempt 的结果记录；
 * - required 断言结果为 PASS 时，evidenceIds 不得为空；
 * - 每个 evidence Artifact 必须存在、属于本项目与本次 attempt、
 *   文件存在且内容 sha256 与登记 checksum 一致（损坏即失效）；
 * - 任何缺失 → 用例降级 REVIEW（evidenceDowngraded），严格验收 INCOMPLETE。
 */

export interface CasePlanPin {
  caseVersionId: string;
  planVersionId: string;
  acceptanceHash: string;
}

interface PlanAssertionShape {
  id: string;
  required?: boolean;
}

export interface AssertionView {
  assertionId: string;
  expected: string | null;
  actual: string | null;
  unit: string | null;
  result: string;
  note: string | null;
  required: boolean;
  evidence: Array<{
    artifactId: string;
    type: string;
    sensitivity: string;
    url: string;
    exists: boolean;
    integrityOk: boolean;
    belongsToAttempt: boolean;
  }>;
}

export interface CaseReportView {
  caseVersionId: string;
  title: string;
  verdict: "PASS" | "FAIL" | "BLOCKED" | "REVIEW" | "NOT_RUN";
  reportedVerdict: string;
  reasonCode: string;
  unstable: boolean;
  evidenceDowngraded: boolean;
  downgradeReasons: string[];
  planVersionId: string | null;
  attemptId: string | null;
  traces: Array<{ artifactId: string; type: string; sensitivity: string; url: string; exists: boolean }>;
  assertions: AssertionView[];
}

export interface RunReport {
  run: {
    id: string;
    lifecycle: string;
    acceptanceStatus: string;
    mode: string;
    buildId: string | null;
    /** 用户/调用者是否声明了构建号（≠ 已验证）。 */
    buildDeclared: boolean;
    /** 目标构建身份是否已核验。阶段 1 恒为 false（核验未实现）。 */
    buildVerified: boolean;
  };
  metrics: {
    totalSelected: number;
    counts: Record<string, number>;
    unstable: number;
    executionRateDisplay: string;
    passRateDisplay: string;
    ruleCoverageDisplay: string;
    acceptanceStatus: string;
  };
  cases: CaseReportView[];
}

export async function buildRunReport(
  prisma: PrismaClient,
  store: ArtifactStore,
  runId: string,
): Promise<RunReport> {
  const run = await prisma.run.findUnique({ where: { id: runId }, include: { attempts: true } });
  if (!run) throw new Error(`运行不存在：${runId}`);
  const pins = (run.casePlanPins ?? []) as unknown as CasePlanPin[];

  const caseRows = await prisma.testCaseVersion.findMany({
    where: { id: { in: run.selectedCaseVersionIds } },
  });

  const cases: CaseReportView[] = [];
  for (const caseVersionId of run.selectedCaseVersionIds) {
    const attempt = run.attempts.find((a) => a.caseVersionId === caseVersionId);
    const pin = pins.find((p) => p.caseVersionId === caseVersionId);
    const planVersion = pin
      ? await prisma.testPlanVersion.findUnique({ where: { id: pin.planVersionId } })
      : await prisma.testPlanVersion.findFirst({
          where: { caseVersionId },
          orderBy: { version: "desc" },
        });

    const downgradeReasons: string[] = [];
    let verdict = (attempt?.verdict ?? "NOT_RUN") as CaseReportView["verdict"];

    const assertionRecords = attempt
      ? await prisma.assertionResultRecord.findMany({ where: { attemptId: attempt.id } })
      : [];

    const rawAssertions = (planVersion?.plan as { assertions?: unknown } | null)?.assertions;
    const planAssertions: PlanAssertionShape[] = Array.isArray(rawAssertions)
      ? rawAssertions.filter((a) => a && typeof a.id === "string") : [];
    const requiredIds = planAssertions.filter((a) => a.required !== false).map((a) => a.id);
    const caseRow = caseRows.find((c) => c.id === caseVersionId);
    const parsedCase = caseRow && TestCaseVersion.safeParse({
      ...caseRow, description: caseRow.description ?? undefined,
      approvalHash: caseRow.approvalHash ?? undefined, createdAt: caseRow.createdAt.toISOString(),
    });
    if (!planVersion || !parsedCase?.success || !verifyStoredPlan(planVersion.plan, parsedCase.data).ok ||
        (pin && (planVersion.caseVersionId !== caseVersionId || planVersion.acceptanceHash !== pin.acceptanceHash))) {
      downgradeReasons.push("固定计划缺失、被修改或与已批准用例不一致");
    }
    if (requiredIds.length === 0) downgradeReasons.push("固定计划缺少必需断言，不能 PASS");

    const assertionViews: AssertionView[] = [];
    for (const record of assertionRecords) {
      const planAssertion = planAssertions.find((a) => a.id === record.assertionId);
      const required = planAssertion ? planAssertion.required !== false : true;
      const evidence: AssertionView["evidence"] = [];
      for (const artifactId of record.evidenceIds) {
        const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
        const exists = artifact ? store.exists(artifact.storageKey) && (!artifact.expiresAt || artifact.expiresAt > new Date()) : false;
        let integrityOk = false;
        if (artifact && exists) {
          try {
            const content = store.read(artifact.storageKey);
            integrityOk = Boolean(
              artifact.checksum && createHash("sha256").update(content).digest("hex") === artifact.checksum,
            );
          } catch {
            integrityOk = false;
          }
        }
        const belongsToAttempt = artifact?.attemptId === attempt?.id && artifact?.projectId === run.projectId;
        evidence.push({
          artifactId,
          type: artifact?.type ?? "UNKNOWN",
          sensitivity: artifact?.sensitivity ?? "NORMAL",
          url: `/api/artifacts/${artifactId}`,
          exists,
          integrityOk,
          belongsToAttempt,
        });
      }
      // 证据完整性（R5）：
      if (required && record.result === "PASS") {
        if (record.evidenceIds.length === 0) {
          downgradeReasons.push(`必需断言 ${record.assertionId} PASS 但 evidenceIds 为空`);
        } else {
          for (const e of evidence) {
            if (!e.exists) downgradeReasons.push(`必需断言 ${record.assertionId} 证据文件缺失（${e.artifactId}）`);
            else if (!e.belongsToAttempt)
              downgradeReasons.push(`必需断言 ${record.assertionId} 证据归属错误（${e.artifactId}）`);
            else if (!e.integrityOk)
              downgradeReasons.push(`必需断言 ${record.assertionId} 证据校验和不符（${e.artifactId}）`);
          }
        }
      }
      assertionViews.push({
        assertionId: record.assertionId,
        expected: record.expected,
        actual: record.actual,
        unit: record.unit,
        result: record.result,
        note: record.note,
        required,
        evidence,
      });
    }

    // 固定计划的必需断言必须有结果记录（R5：空记录集不能 PASS）。
    for (const requiredId of requiredIds) {
      const records = assertionRecords.filter((r) => r.assertionId === requiredId);
      if (records.length === 0) {
        downgradeReasons.push(`必需断言 ${requiredId} 缺少结果记录`);
      } else if (records.length !== 1) {
        downgradeReasons.push(`必需断言 ${requiredId} 结果记录重复`);
      } else if (records[0]!.result !== "PASS" && attempt?.verdict === "PASS") {
        downgradeReasons.push(`必需断言 ${requiredId} 为 ${records[0]!.result}，与用例 PASS 不一致`);
      }
    }
    if (attempt && attempt.verdict === "PASS" && downgradeReasons.length > 0) {
      verdict = "REVIEW";
    }

    const traces = attempt
      ? (
          await prisma.artifact.findMany({
            where: { attemptId: attempt.id, type: "TRACE" },
            select: { id: true, type: true, sensitivity: true, storageKey: true, expiresAt: true },
          })
        ).map((t) => ({
          artifactId: t.id,
          type: t.type,
          sensitivity: t.sensitivity,
          url: `/api/artifacts/${t.id}`,
          exists: store.exists(t.storageKey) && (!t.expiresAt || t.expiresAt > new Date()),
        }))
      : [];

    cases.push({
      caseVersionId,
      title: caseRows.find((c) => c.id === caseVersionId)?.title ?? caseVersionId,
      verdict,
      reportedVerdict: attempt?.verdict ?? "NOT_RUN",
      reasonCode: verdict === "REVIEW" && attempt?.verdict === "PASS" ? "TEST_DATA" : attempt?.reasonCode ?? "NONE",
      unstable: attempt?.unstable ?? false,
      evidenceDowngraded: verdict === "REVIEW" && attempt?.verdict === "PASS",
      downgradeReasons,
      planVersionId: planVersion?.id ?? null,
      attemptId: attempt?.id ?? null,
      traces,
      assertions: assertionViews,
    });
  }

  // 规则覆盖率（基线范围）。
  const baseline = await prisma.baseline.findUnique({ where: { id: run.baselineId } });
  const ruleVersions = baseline?.ruleVersionIds ?? [];
  const covered = new Set<string>();
  for (const caseRow of caseRows) {
    for (const ruleId of caseRow.ruleVersionIds) covered.add(ruleId);
  }
  const build = (run.buildVerification ?? {}) as Record<string, { verified?: boolean; observed?: string; evidenceId?: string }>;
  let buildVerified = Boolean(build.before?.verified && build.after?.verified && build.before.observed === run.buildId && build.after.observed === run.buildId);
  for (const name of ["before", "after"]) {
    const phase = build[name];
    const evidence = phase?.evidenceId ? await prisma.artifact.findUnique({ where: { id: phase.evidenceId } }) : null;
    if (!evidence || (evidence.expiresAt && evidence.expiresAt <= new Date()) || evidence.projectId !== run.projectId || evidence.type !== "BUILD_IDENTITY" || !store.verify(evidence.storageKey, evidence.checksum)) { buildVerified = false; continue; }
    try {
      const proof = JSON.parse(store.read(evidence.storageKey).toString());
      if (proof.phase !== name || proof.expected !== run.buildId || proof.observed !== run.buildId || proof.verified !== true) buildVerified = false;
    } catch { buildVerified = false; }
  }
  const missionRun = await prisma.missionRun.findUnique({where:{runId}});
  const mission = missionRun ? await prisma.mission.findUnique({where:{id:missionRun.missionId}}) : null;
  const excluded = Array.isArray(mission?.exclusions) && mission.exclusions.length > 0;
  const metrics = aggregateRun({
    buildVerified,
    scopeComplete: !excluded && (baseline?.ruleVersionIds ?? []).every(id => covered.has(id)) && (baseline?.caseVersionIds ?? []).every(id => run.selectedCaseVersionIds.includes(id)),
    cases: cases.map((c) => ({
      caseVersionId: c.caseVersionId,
      verdict: c.verdict,
      reasonCode: c.reasonCode,
      unstable: c.unstable,
    })),
    baselineRuleTotal: ruleVersions.length,
    baselineRuleCovered: [...covered].filter((r) => ruleVersions.includes(r)).length,
    hasBuildId: run.buildId !== null && run.buildId !== undefined,
    cancelled: run.lifecycle === "CANCELLED",
    platformError: run.lifecycle === "ERROR",
  });

  const acceptanceStatus = metrics.acceptanceStatus;

  return {
    run: {
      id: run.id,
      lifecycle: run.lifecycle,
      acceptanceStatus,
      mode: run.mode,
      buildId: run.buildId,
      buildDeclared: run.buildId !== null && run.buildId !== undefined,
      // 阶段 1 未实现目标构建身份核验（§三.4）：声明 ≠ 已验证。
      buildVerified,
    },
    metrics: {
      totalSelected: metrics.totalSelected,
      counts: metrics.counts as unknown as Record<string, number>,
      unstable: metrics.unstable,
      executionRateDisplay: percent(metrics.executionRate),
      passRateDisplay: percent(metrics.passRate),
      ruleCoverageDisplay: percent(metrics.ruleCoverage),
      acceptanceStatus,
    },
    cases,
  };
}

/** A failure becomes a candidate defect with immutable occurrences; passing runs never erase history. */
export async function syncRunDefects(prisma: import('@prisma/client').PrismaClient, store: ArtifactStore, runId: string) {
  const report = await buildRunReport(prisma, store, runId);
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (run.lifecycle !== 'FINISHED') return;
  const attempts = await prisma.caseAttempt.findMany({ where: { runId, verdict: 'FAIL' }, include: { assertions: true, caseVersion: true } });
  for (const attempt of attempts) {
    if (!report.cases.some(c => c.caseVersionId === attempt.caseVersionId && c.verdict === 'FAIL')) continue;
    for (const assertion of attempt.assertions.filter(a => a.result === 'FAIL' && a.evidenceIds.length)) {
      const visible = report.cases.find(c=>c.attemptId===attempt.id)?.assertions.find(a=>a.assertionId===assertion.assertionId);
      if (!visible?.required || !visible.evidence.length || visible.evidence.some(e=>!e.integrityOk||!e.belongsToAttempt||!e.exists)) continue;
      const definition = (attempt.caseVersion.assertions as Array<{ id: string; ruleVersionId: string; description: string }>).find(a => a.id === assertion.assertionId);
      if (!definition) continue;
      const fingerprint = `${attempt.caseVersion.caseId}:${definition.ruleVersionId}:${definition.id}`;
      const defect = await prisma.defect.upsert({ where: { projectId_fingerprint: { projectId: run.projectId, fingerprint } }, create: { projectId: run.projectId, fingerprint, sourceRuleVersionId: definition.ruleVersionId, assertionId: definition.id, title: `${attempt.caseVersion.title}：${definition.description}`, description: `预期：${assertion.expected ?? ''}\n实际：${assertion.actual ?? ''}` }, update: {} });
      await prisma.defectOccurrence.upsert({ where: { defectId_runId_attemptId: { defectId: defect.id, runId, attemptId: attempt.id } }, create: { defectId: defect.id, runId, attemptId: attempt.id, buildId: run.buildId, evidenceRefs: assertion.evidenceIds }, update: {} });
      await prisma.defect.updateMany({ where: { id: defect.id, status: 'VERIFIED' }, data: { status: 'REOPENED' } });
    }
  }
}
