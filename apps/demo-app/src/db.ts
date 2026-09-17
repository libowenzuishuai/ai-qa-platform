import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DemoConfig } from "./config.js";

/**
 * SQLite 持久化。金额一律以“分”为整数存储（PRD §12.1）。
 * 订单状态使用稳定英文值：DRAFT / PENDING_APPROVAL / AWAITING_PAYMENT /
 * APPROVED / REJECTED；界面显示中文。
 */
export type OrderStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "AWAITING_PAYMENT"
  | "APPROVED"
  | "REJECTED";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: "草稿",
  PENDING_APPROVAL: "待审批",
  AWAITING_PAYMENT: "付款待办",
  APPROVED: "已审批",
  REJECTED: "已驳回",
};

/** 审批阈值（分）：超过该值需主管审批。 */
export const APPROVAL_THRESHOLD_CENTS = 500_000;

export interface DemoUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: "applicant" | "supervisor";
}

export interface DemoOrder {
  id: string;
  title: string;
  amount_cents: number;
  note: string | null;
  status: OrderStatus;
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  namespace: string | null;
}

export function openDatabase(config: DemoConfig): DatabaseSync {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('applicant','supervisor'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      note TEXT,
      status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','AWAITING_PAYMENT','APPROVED','REJECTED')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      approved_by TEXT,
      approved_at TEXT,
      rejected_reason TEXT,
      namespace TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE TABLE IF NOT EXISTS approval_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      actor TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      note TEXT,
      at TEXT NOT NULL
    );
  `);
  // 旧库升级：幂等补列（存在则忽略错误）；namespace 索引在补列后创建。
  try {
    db.exec("ALTER TABLE orders ADD COLUMN namespace TEXT");
  } catch {
    /* column exists */
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_orders_namespace ON orders(namespace)");
  seedUsers(db);
  return db;
}

function seedUsers(db: DatabaseSync): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (count.n > 0) return;
  const insert = db.prepare(
    "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)",
  );
  // 演示账号；密码仅用于演示环境，不与任何真实系统相关。
  // 评测器可通过环境变量覆盖密码（用于"账号失效"场景注入）。
  const applicantPassword = process.env.DEMO_APPLICANT_PASSWORD ?? "Applicant#2026";
  const supervisorPassword = process.env.DEMO_SUPERVISOR_PASSWORD ?? "Supervisor#2026";
  insert.run(randomUUID(), "applicant1", hashPassword(applicantPassword), "王一（申请人）", "applicant");
  insert.run(randomUUID(), "supervisor1", hashPassword(supervisorPassword), "李二（主管）", "supervisor");
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

export function findUserByUsername(db: DatabaseSync, username: string): DemoUserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | DemoUserRow
    | undefined;
}

export function findUserById(db: DatabaseSync, id: string): DemoUserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as DemoUserRow | undefined;
}

/** 元字符串 → 分整数。最多两位小数，避免浮点误差。 */
export function parseYuanToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [intPart, decPart = ""] = trimmed.split(".");
  const cents = Number(intPart) * 100 + Number((decPart + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToYuanDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function generateOrderId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const seq = randomBytes(3).toString("hex").toUpperCase();
  return `PO-${date}-${seq}`;
}
