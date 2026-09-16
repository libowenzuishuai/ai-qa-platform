import { PrismaClient } from "@prisma/client";

/**
 * 数据库不变量验证（评审 R6）。
 *
 * 在临时数据库上复现评审中的四个攻击场景，确认修改后被数据库拒绝：
 *   1. 项目 A 的 Run 引用项目 B 的环境 → 复合外键拒绝；
 *   2. Run 引用不存在的 baseline → 外键拒绝；
 *   3. CaseAttempt 引用不存在的用例版本 → 外键拒绝；
 *   4. 已批准 RuleVersion / TestCaseVersion 语义字段原地 UPDATE → 触发器拒绝；
 *      工作流字段（reviewStatus → SUPERSEDED）更新仍被允许。
 *
 * 运行方式（使用临时库，验证后删除，不触碰业务库）：
 *   docker exec ai-qa-postgres-1 createdb -U aiqa aiqa_invariants
 *   DATABASE_URL=postgresql://.../aiqa_invariants pnpm --filter @ai-qa/api exec prisma migrate deploy
 *   DATABASE_URL=postgresql://.../aiqa_invariants pnpm --filter @ai-qa/api exec tsx scripts/verify-db-invariants.ts
 *   docker exec ai-qa-postgres-1 dropdb -U aiqa aiqa_invariants
 */

const prisma = new PrismaClient();

let failed = 0;

function report(name: string, ok: boolean, detail: string) {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failed += 1;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectRejected(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    report(name, false, "操作未被拒绝");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report(name, match.test(message), `已拒绝：${message.split("\n")[0]?.slice(0, 120)}`);
  }
}

async function main() {
  // 基础数据：两个项目、B 项目的环境、A/B 各自 baseline。
  const projectA = await prisma.project.create({ data: { name: "项目A" } });
  const projectB = await prisma.project.create({ data: { name: "项目B" } });
  const envB = await prisma.environment.create({
    data: {
      projectId: projectB.id,
      name: "B-测试环境",
      baseUrl: "http://127.0.0.1:7400",
      allowedOrigins: ["http://127.0.0.1:7400"],
    },
  });
  const baselineA = await prisma.baseline.create({
    data: { projectId: projectA.id, name: "A-基线", ruleVersionIds: [], caseVersionIds: [] },
  });
  const budget = { maxToolActionsPerCase: 50 };

  await expectRejected(
    "R6-1 跨项目：项目 A 的 Run 引用项目 B 的环境",
    () =>
      prisma.run.create({
        data: {
          projectId: projectA.id,
          baselineId: baselineA.id,
          environmentId: envB.id, // 属于项目 B —— 必须被拒绝
          mode: "real",
          selectedCaseVersionIds: [],
          budget,
          idempotencyKey: "inv-key-0001",
        },
      }),
    /foreign key|CaseAttempt|Run/i,
  );

  await expectRejected(
    "R6-2 悬空引用：Run 引用不存在的 baseline",
    () =>
      prisma.run.create({
        data: {
          projectId: projectA.id,
          baselineId: "baseline-does-not-exist",
          environmentId: envB.id,
          mode: "real",
          selectedCaseVersionIds: [],
          budget,
          idempotencyKey: "inv-key-0002",
        },
      }),
    /foreign key/i,
  );

  // 合法 Run（A 项目 + A 环境）供 attempt 场景使用。
  const envA = await prisma.environment.create({
    data: {
      projectId: projectA.id,
      name: "A-测试环境",
      baseUrl: "http://127.0.0.1:7400",
      allowedOrigins: ["http://127.0.0.1:7400"],
    },
  });
  const runA = await prisma.run.create({
    data: {
      projectId: projectA.id,
      baselineId: baselineA.id,
      environmentId: envA.id,
      mode: "real",
      selectedCaseVersionIds: [],
      budget,
      idempotencyKey: "inv-key-0003",
    },
  });

  await expectRejected(
    "R6-3 悬空引用：CaseAttempt 引用不存在的用例版本",
    () =>
      prisma.caseAttempt.create({
        data: {
          runId: runA.id,
          caseVersionId: "tc-version-does-not-exist",
          projectId: projectA.id,
          attemptNo: 1,
          namespace: "ns-1",
        },
      }),
    /foreign key/i,
  );

  // 跨项目 attempt：A 的 run + B 的用例版本 → 复合外键拒绝。
  const caseB = await prisma.testCase.create({ data: { projectId: projectB.id } });
  const caseVersionB = await prisma.testCaseVersion.create({
    data: {
      caseId: caseB.id,
      version: 1,
      title: "B 用例",
      ruleVersionIds: [],
      roles: ["applicant"],
      dataSpec: { strategy: "create", note: "x" },
      steps: [],
      assertions: [],
      cleanup: { strategy: "manual" },
      origin: "manual",
      projectId: projectB.id,
    },
  });
  await expectRejected(
    "R6-4 跨项目：项目 A 的 attempt 引用项目 B 的用例版本",
    () =>
      prisma.caseAttempt.create({
        data: {
          runId: runA.id,
          caseVersionId: caseVersionB.id,
          projectId: projectA.id,
          attemptNo: 2,
          namespace: "ns-2",
        },
      }),
    /foreign key/i,
  );

  // 已批准 RuleVersion 语义改写。
  const ruleA = await prisma.rule.create({ data: { projectId: projectA.id } });
  const approvedRule = await prisma.ruleVersion.create({
    data: {
      ruleId: ruleA.id,
      version: 1,
      statement: "金额超过 500000 分需主管审批",
      classification: "EXPLICIT",
      action: "提交采购单",
      expectation: "进入待审批状态",
      sources: [],
      reviewStatus: "APPROVED",
      origin: "manual",
    },
  });
  await expectRejected(
    "R6-5 已批准 RuleVersion 语义字段原地 UPDATE（expectation）",
    () =>
      prisma.ruleVersion.update({
        where: { id: approvedRule.id },
        data: { expectation: "直接通过（被篡改）" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );
  // 工作流字段变更允许。
  try {
    await prisma.ruleVersion.update({
      where: { id: approvedRule.id },
      data: { reviewStatus: "SUPERSEDED", reviewedBy: "admin", reviewedAt: new Date() },
    });
    report("R6-6 工作流字段更新（reviewStatus → SUPERSEDED）被允许", true);
  } catch (err) {
    report("R6-6 工作流字段更新（reviewStatus → SUPERSEDED）被允许", false, String(err));
  }

  // 已批准 TestCaseVersion 语义改写。
  const caseA = await prisma.testCase.create({ data: { projectId: projectA.id } });
  const approvedCase = await prisma.testCaseVersion.create({
    data: {
      caseId: caseA.id,
      version: 1,
      title: "A 用例",
      ruleVersionIds: [],
      roles: ["applicant"],
      dataSpec: { strategy: "create", note: "x" },
      steps: [],
      assertions: [],
      cleanup: { strategy: "manual" },
      origin: "manual",
      approvalStatus: "APPROVED",
      approvalHash: "hash-1",
      projectId: projectA.id,
    },
  });
  await expectRejected(
    "R6-7 已批准 TestCaseVersion 语义字段原地 UPDATE（title）",
    () =>
      prisma.testCaseVersion.update({
        where: { id: approvedCase.id },
        data: { title: "被篡改的标题" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );

  // ---------- F1：绕过不可变约束的路径 ----------

  const ruleB = await prisma.rule.create({ data: { projectId: projectA.id } });
  const frozenRule = await prisma.ruleVersion.create({
    data: {
      ruleId: ruleB.id,
      version: 1,
      statement: "F1 冻结规则",
      classification: "EXPLICIT",
      action: "提交",
      expectation: "原始预期",
      sources: [],
      reviewStatus: "APPROVED",
      origin: "manual",
    },
  });
  if (frozenRule.semanticFrozen) {
    report("F1-0 INSERT 即 APPROVED 自动冻结", true);
  } else {
    report("F1-0 INSERT 即 APPROVED 自动冻结", false, "semanticFrozen 未置位");
  }

  await expectRejected(
    "F1-1 同次 UPDATE：改状态为 SUPERSEDED 并改语义",
    () =>
      prisma.ruleVersion.update({
        where: { id: frozenRule.id },
        data: { reviewStatus: "SUPERSEDED", expectation: "被篡改" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );

  // 先只改状态（合法），再改语义（必须仍被拒绝）。
  await prisma.ruleVersion.update({
    where: { id: frozenRule.id },
    data: { reviewStatus: "SUPERSEDED" },
  });
  await expectRejected(
    "F1-2 状态已变（SUPERSEDED）后再改语义",
    () =>
      prisma.ruleVersion.update({
        where: { id: frozenRule.id },
        data: { expectation: "再次篡改" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );

  await prisma.ruleVersion.update({
    where: { id: frozenRule.id },
    data: { reviewStatus: "DRAFT" },
  });
  await expectRejected(
    "F1-3 退回 DRAFT 后再改语义",
    () =>
      prisma.ruleVersion.update({
        where: { id: frozenRule.id },
        data: { expectation: "退草稿后篡改" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );
  await expectRejected(
    "F1-4 显式解除冻结标志",
    () =>
      prisma.ruleVersion.update({
        where: { id: frozenRule.id },
        data: { semanticFrozen: false },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );

  const frozenCase2 = await prisma.testCaseVersion.create({
    data: {
      caseId: caseA.id,
      version: 2,
      title: "F1 用例",
      ruleVersionIds: [],
      roles: ["applicant"],
      dataSpec: { strategy: "create", note: "x" },
      steps: [],
      assertions: [],
      cleanup: { strategy: "manual" },
      origin: "manual",
      approvalStatus: "APPROVED",
      approvalHash: "hash-f1",
      projectId: projectA.id,
    },
  });
  await expectRejected(
    "F1-5 用例：同次 UPDATE 改状态并改 title",
    () =>
      prisma.testCaseVersion.update({
        where: { id: frozenCase2.id },
        data: { approvalStatus: "SUPERSEDED", title: "被篡改的标题" },
      }),
    /IMMUTABLE_SEMANTIC_FIELDS/,
  );
  try {
    await prisma.testCaseVersion.update({
      where: { id: frozenCase2.id },
      data: { approvalStatus: "SUPERSEDED" },
    });
    report("F1-6 用例工作流字段单独更新仍被允许", true);
  } catch (err) {
    report("F1-6 用例工作流字段单独更新仍被允许", false, String(err));
  }

  // ---------- F4：版本与父用例必须同项目 ----------

  const caseB2 = await prisma.testCase.create({ data: { projectId: projectB.id } });
  await expectRejected(
    "F4-1 TestCaseVersion.projectId 与父 TestCase 不一致（B 用例填 A 项目）",
    () =>
      prisma.testCaseVersion.create({
        data: {
          caseId: caseB2.id,
          version: 1,
          title: "F4 越界版本",
          ruleVersionIds: [],
          roles: ["applicant"],
          dataSpec: { strategy: "create", note: "x" },
          steps: [],
          assertions: [],
          cleanup: { strategy: "manual" },
          origin: "manual",
          projectId: projectA.id,
        },
      }),
    /foreign key/i,
  );

  // 合法链路对照：同项目 case → version → attempt 全部成功。
  try {
    const caseOk = await prisma.testCase.create({ data: { projectId: projectA.id } });
    const versionOk = await prisma.testCaseVersion.create({
      data: {
        caseId: caseOk.id,
        version: 1,
        title: "F4 合法链路",
        ruleVersionIds: [],
        roles: ["applicant"],
        dataSpec: { strategy: "create", note: "x" },
        steps: [],
        assertions: [],
        cleanup: { strategy: "manual" },
        origin: "manual",
        projectId: projectA.id,
      },
    });
    await prisma.caseAttempt.create({
      data: {
        runId: runA.id,
        caseVersionId: versionOk.id,
        projectId: projectA.id,
        attemptNo: 3,
        namespace: "ns-f4",
      },
    });
    report("F4-2 同项目 case→version→attempt 合法链路成功", true);
  } catch (err) {
    report("F4-2 同项目 case→version→attempt 合法链路成功", false, String(err));
  }

  // 清理（临时库整体会被删除，这里只为输出整洁）。
  console.log(failed === 0 ? "\n全部不变量验证通过" : `\n${failed} 项验证失败`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
