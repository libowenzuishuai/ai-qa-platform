import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { TestCaseVersion, computePlanAcceptanceHash } from "@ai-qa/contracts";

/**
 * 边界测试基础设施：每次运行创建独立临时 PostgreSQL 库与证据目录，
 * 迁移后供测试使用；结束后全部清理。不在开发库上做任何篡改测试。
 */

export const PG_CONTAINER = "ai-qa-postgres-1";
export const PG_USER = "aiqa";
export const PG_PASSWORD = "aiqa_dev_password";
export const PG_PORT = 5435;

export interface TestEnv {
  databaseUrl: string;
  prisma: PrismaClient;
  store: ArtifactStore;
  artifactDir: string;
  cleanup(): Promise<void>;
}

export async function createTestEnv(prefix: string): Promise<TestEnv> {
  const stamp = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dbName = `aiqa_test_${stamp.replace(/-/g, "_")}`;
  execFileSync("docker", ["exec", PG_CONTAINER, "createdb", "-U", PG_USER, dbName]);
  const databaseUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${dbName}?schema=public`;
  execFileSync(
    "node_modules/.bin/prisma",
    ["migrate", "deploy"],
    { cwd: join(process.cwd(), "../api"), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
  );
  const artifactDir = join(tmpdir(), `artifacts-${stamp}`);
  mkdirSync(artifactDir, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    databaseUrl,
    prisma,
    store: new ArtifactStore(artifactDir),
    artifactDir,
    cleanup: async () => {
      await prisma.$disconnect();
      execFileSync("docker", ["exec", PG_CONTAINER, "dropdb", "-U", PG_USER, dbName]);
      rmSync(artifactDir, { recursive: true, force: true });
    },
  };
}

/** 构造最小可用资产：项目/环境/基线/规则/用例/计划（含真实观察证据文件）。 */
export async function seedMinimalAssets(
  prisma: PrismaClient,
  store: ArtifactStore,
  overrides: {
    ruleStatus?: string;
    fakeEvidence?: boolean;
    crossProjectEvidence?: boolean;
  } = {},
): Promise<{
  projectId: string;
  baselineId: string;
  environmentId: string;
  caseVersionId: string;
  planVersionId: string;
  evidenceArtifactId: string;
}> {
  const projectId = (
    await prisma.project.create({ data: { name: `边界测试-${Date.now()}` } })
  ).id;
  const environmentId = (
    await prisma.environment.create({
      data: {
        projectId,
        name: "测试环境",
        baseUrl: "http://127.0.0.1:7999",
        allowedOrigins: ["http://127.0.0.1:7999"],
      },
    })
  ).id;

  // 规则（可注入状态）。
  const ruleId = (await prisma.rule.create({ data: { projectId } })).id;
  const ruleVersionId = (
    await prisma.ruleVersion.create({
      data: {
        ruleId,
        version: 1,
        statement: "规则",
        classification: "INFERRED",
        action: "动作",
        expectation: "预期",
        sources: [],
        reviewStatus: overrides.ruleStatus ?? "APPROVED",
        origin: "manual",
      },
    })
  ).id;

  // 用例（APPROVED + 真实 acceptanceHash）。
  const caseId = (await prisma.testCase.create({ data: { projectId } })).id;
  const assertions = [
    { id: "a1", description: "状态", kind: "ui.text" as const, required: true, ruleVersionId, operator: "equals" as const, expected: "付款待办" },
  ];

  // 观察证据（真实文件）。
  let evidenceProjectId = projectId;
  let evidenceArtifactId: string;
  if (overrides.fakeEvidence) {
    evidenceArtifactId = "nonexistent-evidence-000";
  } else {
    if (overrides.crossProjectEvidence) {
      evidenceProjectId = (await prisma.project.create({ data: { name: "他项目" } })).id;
    }
    const stored = store.put({
      runId: "seed-test",
      attemptId: "observation",
      filename: `obs-${Date.now()}.png`,
      data: Buffer.from("png-bytes"),
    });
    evidenceArtifactId = (
      await prisma.artifact.create({
        data: {
          projectId: evidenceProjectId,
          attemptId: null,
          storageKey: stored.storageKey,
          type: "OBSERVATION",
          sensitivity: "NORMAL",
          checksum: stored.checksum,
        },
      })
    ).id;
  }

  // 计划 v1（绑定证据；哈希在证据 id 确定后计算）。
  const planDraftBase = {
    schemaVersion: "1.0",
    caseVersionId: "placeholder-overridden-below",
    ruleVersionIds: [ruleVersionId],
    roles: ["applicant"],
    bindings: [
      { targetRef: "order-status", locator: { type: "testId", value: "order-status" }, observedUrl: "http://127.0.0.1:7999/orders", observedAt: "2026-09-17T00:00:00Z", evidenceId: evidenceArtifactId },
    ],
    actions: [
      { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "s2", type: "assert", assertionId: "a1", effect: "READ" },
    ],
    assertions: [
      { id: "a1", stepId: "s2", required: true, ruleVersionId, kind: "ui.text", targetRef: "order-status", operator: "equals", expected: "付款待办" },
    ],
  };
  const finalCaseId = `case-v1-${Math.random().toString(36).slice(2, 10)}`;
  const caseDraftFinal = TestCaseVersion.safeParse({
    id: finalCaseId,
    caseId,
    version: 1,
    title: "边界用例",
    ruleVersionIds: [ruleVersionId],
    roles: ["applicant"],
    preconditions: [],
    dataSpec: { strategy: "create", note: "x" },
    steps: [{ id: "st1", role: "applicant", action: "a" }],
    assertions,
    cleanup: { strategy: "namespace" },
    priority: "P1",
    approvalStatus: "DRAFT",
    supersedesId: null,
    origin: "manual",
    promptVersion: null,
    projectId,
    createdAt: new Date().toISOString(),
  });
  if (!caseDraftFinal.success) {
    throw new Error("测试资产用例解析失败: " + JSON.stringify(caseDraftFinal.error.issues.slice(0, 3)));
  }
  const planDraft = {
    ...planDraftBase,
    caseVersionId: finalCaseId,
  };
  const acceptanceHash = computePlanAcceptanceHash({
    testCase: caseDraftFinal.data,
    plan: planDraft as never,
  });
  // 存库的计划 JSON 本身必须含 acceptanceHash（verifyStoredPlan 重新解析）。
  const finalPlan = { ...planDraft, acceptanceHash };
  const caseVersionId = (
    await prisma.testCaseVersion.create({
      data: {
        id: finalCaseId,
        caseId,
        version: 1,
        title: "边界用例",
        ruleVersionIds: [ruleVersionId],
        roles: ["applicant"],
        preconditions: [],
        dataSpec: { strategy: "create", note: "x" },
        steps: [{ id: "st1", role: "applicant", action: "a" }],
        assertions: assertions as never,
        cleanup: { strategy: "namespace" },
        origin: "manual",
        approvalStatus: "APPROVED",
        approvalHash: acceptanceHash,
        projectId,
      },
    })
  ).id;
  const planVersionId = (
    await prisma.testPlanVersion.create({
      data: {
        caseVersionId,
        version: 1,
        schemaVersion: "1.0",
        plan: finalPlan as never,
        bindingEvidenceIds: [evidenceArtifactId],
        acceptanceHash,
      },
    })
  ).id;

  const baselineId = (
    await prisma.baseline.create({
      data: {
        projectId,
        name: "边界基线",
        ruleVersionIds: [ruleVersionId],
        caseVersionIds: [caseVersionId],
      },
    })
  ).id;

  return { projectId, baselineId, environmentId, caseVersionId, planVersionId, evidenceArtifactId };
}
