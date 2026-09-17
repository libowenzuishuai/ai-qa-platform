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
