import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "./errors.js";

/**
 * 最小平台登录与项目权限（阶段 0）。
 * - 会话落库（Session 表），Cookie httpOnly；
 * - 所有项目读写做服务端鉴权（ProjectMembership），不依赖前端隐藏按钮；
 * - 不写死用户身份绕过鉴权。
 */

const SESSION_COOKIE = "aiqa_sid";

export interface AuthContext {
  userId: string;
  username: string;
  displayName: string;
  platformRole: "ADMIN" | "LEAD" | "VIEWER";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function registerAuth(app: FastifyInstance, prisma: PrismaClient, sessionTtlSeconds: number) {
  // 从 Cookie 恢复会话；失败不抛错，由 requireAuth 拒绝。
  app.decorateRequest("auth", undefined);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    const session = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) return;
    req.auth = {
      userId: session.user.id,
      username: session.user.username,
      displayName: session.user.displayName,
      platformRole: session.user.platformRole as AuthContext["platformRole"],
    };
  });

  const Credentials = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = Credentials.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new ApiError("UNAUTHENTICATED", "用户名或密码错误");
    }
    const sid = randomUUID();
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    await prisma.session.create({ data: { id: sid, userId: user.id, expiresAt } });
    reply.setCookie(SESSION_COOKIE, sid, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      platformRole: user.platformRole,
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await prisma.session.deleteMany({ where: { id: sid } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    if (!req.auth) throw new ApiError("UNAUTHENTICATED", "未登录");
    return req.auth;
  });
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError("UNAUTHENTICATED", "未登录或会话已过期");
  return req.auth;
}

/** 项目访问鉴权：所有项目读写必须通过（服务端）。 */
export async function requireProjectAccess(
  prisma: PrismaClient,
  req: FastifyRequest,
  projectId: string,
  minimum: "VIEWER" | "LEAD" | "ADMIN" = "VIEWER",
): Promise<{ role: "ADMIN" | "LEAD" | "VIEWER" }> {
  const auth = requireAuth(req);
  const membership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId: auth.userId } },
  });
  if (!membership) {
    // 平台 ADMIN 可以查看任意项目（管理职责），但写操作仍要求成员身份。
    if (auth.platformRole === "ADMIN" && minimum === "VIEWER") {
      return { role: "ADMIN" };
    }
    throw new ApiError("FORBIDDEN", "无该项目的访问权限");
  }
  const role = membership.role as "ADMIN" | "LEAD" | "VIEWER";
  const rank = { VIEWER: 0, LEAD: 1, ADMIN: 2 } as const;
  if (rank[role] < rank[minimum]) {
    throw new ApiError("FORBIDDEN", `需要 ${minimum} 及以上项目权限`);
  }
  return { role };
}
