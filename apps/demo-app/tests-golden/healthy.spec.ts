import { expect, test } from "@playwright/test";
import {
  APPLICANT,
  BASE_URL,
  SUPERVISOR,
  createAndSubmitOrder,
  login,
  logout,
  orderStatus,
  paymentsContains,
} from "./helpers.js";

/**
 * 健康版本黄金验收：完整双角色业务流程在真实浏览器中走通。
 * 对应 PRD §12.1：金额单位分；>500000 分需主管审批；
 * <=500000 分直接进入付款待办；禁止申请人审批。
 */

test("超阈值订单：申请人提交 → 主管审批 → 付款待办，刷新后持久", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "服务器采购", "5000.01");
  // 5000.01 元 = 500001 分 > 500000 分 → 待审批
  expect(await orderStatus(page)).toBe("待审批");

  // 申请人不可审批（服务端拒绝，页面显示错误）
  await page.getByTestId("approve-button").count(); // 申请人看不到审批按钮
  expect(await page.getByTestId("approve-button").count()).toBe(0);

  // 主管在另一会话审批
  await logout(page);
  await login(page, SUPERVISOR);
  await page.goto(`${BASE_URL}/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("待审批");
  await page.getByTestId("approve-button").click();
  expect(await orderStatus(page)).toBe("付款待办");

  // 付款待办包含同一业务 ID
  expect(await paymentsContains(page, orderId)).toBe(true);

  // 申请人刷新后核对同一业务 ID（持久化 + 跨角色一致）
  await logout(page);
  await login(page, APPLICANT);
  await page.goto(`${BASE_URL}/orders/${orderId}`);
  await page.reload();
  expect(await orderStatus(page)).toBe("付款待办");
  expect(await paymentsContains(page, orderId)).toBe(true);
});

test("边界：恰好 5000.00 元（500000 分）直接进入付款待办", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "办公用品", "5000.00");
  expect(await orderStatus(page)).toBe("付款待办");
  expect(await paymentsContains(page, orderId)).toBe(true);
});

test("小额订单免审批直入付款待办", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "文具", "100.00");
  expect(await orderStatus(page)).toBe("付款待办");
});

test("申请人直接调用审批接口被服务端拒绝", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "越权尝试", "6000.00");
  const response = await page.request.post(`${BASE_URL}/orders/${orderId}/approve`);
  expect(response.status()).toBe(403);
  const body = await response.text();
  expect(body).toContain("申请人不可审批");
});

test("非法金额被表单校验拒绝", async ({ page }) => {
  await login(page, APPLICANT);
  await page.goto(`${BASE_URL}/orders/new`);
  await page.getByTestId("title-input").fill("非法金额");
  await page.getByTestId("amount-input").fill("12.345");
  await page.getByTestId("create-submit").click();
  await expect(page.getByTestId("form-error")).toContainText("金额格式不正确");
});
