import { expect, test } from "@playwright/test";
import {
  APPLICANT,
  SUPERVISOR,
  createAndSubmitOrder,
  login,
  logout,
  orderStatus,
  paymentsContains,
} from "./helpers.js";

/**
 * B3 付款状态不同步：审批后订单状态停在“已审批”，付款待办不更新。
 */
test("B3：审批通过后付款待办缺少该单", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "B3 同步单", "5000.01");
  expect(await orderStatus(page)).toBe("待审批");

  await logout(page);
  await login(page, SUPERVISOR);
  await page.goto(`/orders/${orderId}`);
  await page.getByTestId("approve-button").click();
  // 页面显示“已审批”，看起来成功……
  expect(await orderStatus(page)).toBe("已审批");
  // ……但付款待办没有该单（缺陷存在性断言；健康版本应为 true）
  expect(await paymentsContains(page, orderId)).toBe(false);
});
