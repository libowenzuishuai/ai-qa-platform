import { expect, test } from "@playwright/test";
import { APPLICANT, BASE_URL, login } from "./helpers.js";

/**
 * B4 数据未持久化：创建返回成功页面，但数据没有落库，刷新后消失。
 */
test("B4：创建成功提示后数据丢失", async ({ page }) => {
  await login(page, APPLICANT);
  await page.goto(`${BASE_URL}/orders/new`);
  await page.getByTestId("title-input").fill("B4 丢失单");
  await page.getByTestId("amount-input").fill("300.00");
  await page.getByTestId("create-submit").click();

  // 页面显示“采购单创建成功”（成功假象）
  await expect(page.getByTestId("success-message")).toContainText("采购单创建成功");
  const fakeId = (await page.getByTestId("order-id").textContent())!.trim();

  // 列表页（重新加载）没有该单 —— 数据从未落库
  await page.goto(`${BASE_URL}/orders`);
  expect(await page.getByTestId(`order-link-${fakeId}`).count()).toBe(0);
  await page.reload();
  expect(await page.getByTestId(`order-link-${fakeId}`).count()).toBe(0);
});
