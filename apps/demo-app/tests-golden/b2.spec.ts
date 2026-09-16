import { expect, test } from "@playwright/test";
import { APPLICANT, createAndSubmitOrder, login, orderStatus } from "./helpers.js";

/**
 * B2 越权审批：服务端不再拒绝申请人审批。
 * 申请人应收到 403“申请人不可审批”，缺陷版本却让审批成功。
 */
test("B2：申请人审批自己的单据被放行（应 403）", async ({ page }) => {
  await login(page, APPLICANT);
  const orderId = await createAndSubmitOrder(page, "B2 越权单", "6000.00");
  const response = await page.request.post(`/orders/${orderId}/approve`, {
    maxRedirects: 0,
  });
  // 缺陷存在性断言：健康版本应为 403
  expect(response.status()).toBe(302);
  await page.goto(`/orders/${orderId}`);
  expect(await orderStatus(page)).toBe("付款待办");
});
