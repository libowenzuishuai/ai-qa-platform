import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import { loadConfig } from "../src/config.js";

/**
 * 初始管理员种子。用户名/密码来自环境变量，缺省值仅用于本地开发；
 * 不写死用户身份绕过鉴权，不把密码放入代码仓库。
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  loadConfig(); // 校验必需环境变量
  const prisma = new PrismaClient();
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD 未设置或短于 8 位；请通过环境变量提供");
  }
  const existing = await prisma.user.findUnique({ where: { username: adminUsername } });
  if (existing) {
    console.log(`管理员 ${adminUsername} 已存在，跳过`);
    return;
  }
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash: hashPassword(adminPassword),
      displayName: "平台管理员",
      platformRole: "ADMIN",
    },
  });
  // 演示用测试负责人与查看者（密码同样来自环境变量）。
  const leadPassword = process.env.SEED_LEAD_PASSWORD;
  if (leadPassword) {
    await prisma.user.create({
      data: {
        username: "lead1",
        passwordHash: hashPassword(leadPassword),
        displayName: "测试负责人一",
        platformRole: "LEAD",
      },
    });
  }
  const viewerPassword = process.env.SEED_VIEWER_PASSWORD;
  if (viewerPassword) {
    await prisma.user.create({
      data: {
        username: "viewer1",
        passwordHash: hashPassword(viewerPassword),
        displayName: "查看者一",
        platformRole: "VIEWER",
      },
    });
  }
  console.log(`已创建管理员 ${admin.username} (${admin.id})`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
