/**
 * 评测器数据库工具（仅验收 harness 使用；平台运行时不含此能力）。
 * 用法：
 *   tsx dbtool.mts storage-key <artifactId>
 *   tsx dbtool.mts tamper-plan <planId> <assertionIndex> <fakeExpected>
 *   tsx dbtool.mts restore-plan <planId>
 *   tsx dbtool.mts create-user <username> <password> <platformRole> [projectId membershipRole]
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prisma = new PrismaClient();
const [, , command, ...args] = process.argv;

function backupPath(planId: string): string {
  return join(tmpdir(), `plan-backup-${planId}.json`);
}

async function main() {
  switch (command) {
    case "storage-key": {
      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: args[0] } });
      console.log(artifact.storageKey);
      break;
    }
    case "tamper-plan": {
      const [planId, indexRaw, fakeExpected] = args;
      const planVersion = await prisma.testPlanVersion.findUniqueOrThrow({ where: { id: planId } });
      writeFileSync(backupPath(planId), JSON.stringify(planVersion.plan));
      const plan = planVersion.plan as { assertions: Array<Record<string, unknown>> };
      const index = Number(indexRaw);
      plan.assertions[index]!.expected = fakeExpected;
      await prisma.testPlanVersion.update({ where: { id: planId }, data: { plan: plan as never } });
      console.log("tampered");
      break;
    }
    case "restore-plan": {
      const [planId] = args;
      const backup = backupPath(planId);
      if (!existsSync(backup)) throw new Error("无备份文件");
      const plan = JSON.parse(readFileSync(backup, "utf8"));
      await prisma.testPlanVersion.update({ where: { id: planId }, data: { plan: plan as never } });
      unlinkSync(backup);
      console.log("restored");
      break;
    }
    case "add-plan-version": {
      // 复制现有计划为新版本（内容相同、哈希不同）→ 测试"排队期间发布 v2"。
      const [planId] = args;
      const source = await prisma.testPlanVersion.findUniqueOrThrow({ where: { id: planId } });
      const maxVersion = await prisma.testPlanVersion.aggregate({
        where: { caseVersionId: source.caseVersionId },
        _max: { version: true },
      });
      const created = await prisma.testPlanVersion.create({
        data: {
          caseVersionId: source.caseVersionId,
          version: (maxVersion._max.version ?? 1) + 1,
          schemaVersion: source.schemaVersion,
          plan: source.plan as never,
          bindingEvidenceIds: source.bindingEvidenceIds,
          acceptanceHash: "b".repeat(64),
        },
      });
      console.log(created.id);
      break;
    }
    case "plan-expected": {
      const [planId] = args;
      const planVersion = await prisma.testPlanVersion.findUniqueOrThrow({ where: { id: planId } });
      const plan = planVersion.plan as { assertions?: Array<{ id: string; expected?: string }> };
      console.log(String(plan.assertions?.[0]?.expected ?? "none"));
      break;
    }
    case "set-run-stale-cancellation": {
      // 直接置 CANCEL_REQUESTED 且心跳超时 → 触发对账器完成取消（R2）。
      const [runId] = args;
      await prisma.run.update({
        where: { id: runId },
        data: { lifecycle: "CANCEL_REQUESTED", updatedAt: new Date(Date.now() - 200_000) },
      });
      console.log("stale-cancelled");
      break;
    }
    case "create-user": {
      const [username, password, platformRole, projectId, membershipRole] = args;
      const salt = randomBytes(16).toString("hex");
      const passwordHash = `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
      const user = await prisma.user.create({
        data: { username, passwordHash, displayName: `验收-${username}`, platformRole },
      });
      if (projectId && membershipRole) {
        await prisma.projectMembership.create({
          data: { projectId, userId: user.id, role: membershipRole },
        });
      }
      console.log(user.id);
      break;
    }
    default:
      throw new Error(`未知命令：${command}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
