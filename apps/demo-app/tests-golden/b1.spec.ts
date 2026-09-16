import { expect, test } from "@playwright/test";
import { APPLICANT, createAndSubmitOrder, login, orderStatus } from "./helpers.js";

/**
 * B1 阈值写错：`>` 被写成 `>=`。
 * 恰好 5000.00 元（500000 分）在需求下应直接进入付款待办，
 * 缺陷版本错误地要求审批。本测试证明缺陷确实存在。
 */
test("B1：恰好 500000 分被错误送入审批（应为付款待办）", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "B1 边界单", "5000.00");
  const status = await orderStatus(page);
  // 缺陷存在性断言：健康版本此处应为“付款待办”
  expect(status).toBe("待审批");
});

test("B1：超过阈值的金额行为不变（5000.01 仍需审批）", async ({ page }) => {
  await login(page, APPLICANT);
  await createAndSubmitOrder(page, "B1 超阈值单", "5000.01");
  expect(await orderStatus(page)).toBe("待审批");
});
