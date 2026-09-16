import { expect, type Page } from "@playwright/test";

/**
 * 黄金验收测试辅助（评测器专用）。
 *
 * 本目录测试属于“评测器 ground truth”：它们直接知道缺陷模式 B1–B4 的
 * 语义，只用于确认 demo-app 的缺陷确实存在、健康版本确实正确。
 * 测试平台与运行时智能体不得读取本目录内容。
 */

export const BASE_URL = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:7400";
export const APPLICANT = { username: "applicant1", password: "Applicant#2026" };
export const SUPERVISOR = { username: "supervisor1", password: "Supervisor#2026" };

export async function login(page: Page, cred: { username: string; password: string }) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByTestId("login-username").fill(cred.username);
  await page.getByTestId("login-password").fill(cred.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("nav-orders")).toBeVisible();
}

export async function logout(page: Page) {
  const logoutButton = page.getByTestId("logout-button");
  if (await logoutButton.isVisible().catch(() => false)) {
    await logoutButton.click();
    await expect(page.getByTestId("login-form")).toBeVisible();
  }
}

/** 创建草稿并提交，返回业务单号。 */
export async function createAndSubmitOrder(
  page: Page,
  title: string,
  amountYuan: string,
): Promise<string> {
  await page.goto(`${BASE_URL}/orders/new`);
  await page.getByTestId("title-input").fill(title);
  await page.getByTestId("amount-input").fill(amountYuan);
  await page.getByTestId("create-submit").click();
  await expect(page.getByTestId("order-id")).toBeVisible();
  const orderId = (await page.getByTestId("order-id").textContent())!.trim();
  await page.getByTestId("submit-button").click();
  await expect(page.getByTestId("order-status")).toBeVisible();
  return orderId;
}

export async function orderStatus(page: Page): Promise<string> {
  return (await page.getByTestId("order-status").textContent())!.trim();
}

export async function paymentsContains(page: Page, orderId: string): Promise<boolean> {
  await page.goto(`${BASE_URL}/payments`);
  return (await page.getByTestId(`payment-order-id-${orderId}`).count()) > 0;
}
