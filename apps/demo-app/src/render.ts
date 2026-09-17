/**
 * 服务端渲染（纯 HTML 模板，无客户端框架）。
 * 所有可交互元素带 data-testid，供测试平台观察与绑定（PRD FR-05）。
 */
import { STATUS_LABEL, centsToYuanDisplay, type DemoOrder, type OrderStatus } from "./db.js";
import type { DemoUserRow } from "./db.js";

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1f2329; }
  header { background: #2457d6; color: #fff; padding: 12px 24px; display: flex; align-items: center; gap: 24px; }
  header .brand { font-size: 18px; font-weight: 600; }
  nav a { color: #dbe4ff; margin-right: 16px; text-decoration: none; }
  nav a:hover { color: #fff; }
  .user-box { margin-left: auto; font-size: 13px; }
  main { max-width: 960px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { padding: 8px 12px; border: 1px solid #e2e4ea; text-align: left; font-size: 14px; }
  th { background: #f0f2f7; }
  form { background: #fff; padding: 20px; border: 1px solid #e2e4ea; max-width: 520px; }
  label { display: block; margin: 12px 0 4px; font-size: 14px; font-weight: 500; }
  input, textarea, select { width: 100%; padding: 8px; border: 1px solid #c9cdd6; font-size: 14px; }
  button { margin-top: 16px; padding: 8px 20px; background: #2457d6; color: #fff; border: 0; font-size: 14px; cursor: pointer; }
  button.secondary { background: #5c6b8a; }
  button.danger { background: #c72f2f; }
  .error { background: #fdecec; color: #a42121; border: 1px solid #f5c6c6; padding: 10px 14px; margin: 12px 0; font-size: 14px; }
  .success { background: #e9f7ee; color: #1c7c3c; border: 1px solid #bfe6cd; padding: 10px 14px; margin: 12px 0; font-size: 14px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 12px; }
  .status-DRAFT { background: #eef0f4; color: #4e5561; }
  .status-PENDING_APPROVAL { background: #fff4e0; color: #a16500; }
  .status-AWAITING_PAYMENT { background: #e4f0ff; color: #1c54c2; }
  .status-APPROVED { background: #e9f7ee; color: #1c7c3c; }
  .status-REJECTED { background: #fdecec; color: #a42121; }
  dl.detail { background:#fff; border:1px solid #e2e4ea; padding:16px 20px; }
  dl.detail div { display: flex; gap: 12px; padding: 6px 0; font-size: 14px; }
  dl.detail dt { width: 120px; color: #646a73; margin: 0; }
  dl.detail dd { margin: 0; }
`;

type NavUser = { displayName: string; role: "applicant" | "supervisor" } | null;

function layout(title: string, user: NavUser, body: string): string {
  const nav = user
    ? `<nav>
        <a href="/orders" data-testid="nav-orders">采购单</a>
        <a href="/orders/new" data-testid="nav-new-order">新建采购单</a>
        <a href="/payments" data-testid="nav-payments">付款待办</a>
      </nav>
      <div class="user-box">
        <span data-testid="current-user">${user.displayName}</span>
        <form method="post" action="/logout" style="display:inline;padding:0;border:0;background:none">
          <button class="secondary" style="margin:0 0 0 12px;padding:4px 12px" data-testid="logout-button">退出</button>
        </form>
      </div>`
    : "<div class='user-box'>未登录</div>";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 采购审批系统</title>
<style>${STYLE}</style>
</head>
<body>
<header><span class="brand">采购审批系统</span>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "登录",
    null,
    `<h1>登录</h1>
    ${error ? `<div class="error" data-testid="login-error">${error}</div>` : ""}
    <form method="post" action="/login" data-testid="login-form">
      <label for="username">用户名</label>
      <input id="username" name="username" data-testid="login-username" autocomplete="username">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" data-testid="login-password" autocomplete="current-password">
      <button type="submit" data-testid="login-submit">登录</button>
    </form>`,
  );
}

export function ordersPage(
  user: { displayName: string; role: "applicant" | "supervisor" },
  orders: DemoOrder[],
): string {
  const rows = orders
    .map(
      (o) => `<tr>
      <td><a href="/orders/${o.id}" data-testid="order-link-${o.id}">${o.id}</a></td>
      <td>${o.title}</td>
      <td data-testid="order-amount-${o.id}">${centsToYuanDisplay(o.amount_cents)} 元（${o.amount_cents} 分）</td>
      <td><span class="status status-${o.status}" data-testid="order-status-${o.id}">${STATUS_LABEL[o.status]}</span></td>
      <td>${o.created_at}</td>
    </tr>`,
    )
    .join("");
  return layout(
    "采购单",
    user,
    `<h1>采购单列表</h1>
    <p>当前范围采购单数量：<span data-testid="orders-count">${orders.length}</span></p>
    <table data-testid="orders-table">
      <thead><tr><th>单号</th><th>标题</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>暂无采购单</td></tr>"}</tbody>
    </table>`,
  );
}

export function newOrderPage(
  user: { displayName: string; role: "applicant" | "supervisor" },
  error?: string,
): string {
  return layout(
    "新建采购单",
    user,
    `${error ? `<div class="error" data-testid="form-error">${error}</div>` : ""}
    <h1>新建采购单</h1>
    <form method="post" action="/orders" data-testid="order-form">
      <label for="title">标题</label>
      <input id="title" name="title" data-testid="title-input" placeholder="如：服务器采购">
      <label for="amountYuan">金额（元）</label>
      <input id="amountYuan" name="amountYuan" data-testid="amount-input" placeholder="如 5000.01，最多两位小数">
      <label for="note">备注</label>
      <textarea id="note" name="note" data-testid="note-input" rows="3"></textarea>
      <button type="submit" data-testid="create-submit">创建草稿</button>
    </form>`,
  );
}

export function orderDetailPage(
  user: { displayName: string; role: "applicant" | "supervisor" },
  order: DemoOrder,
  canApprove: boolean,
  message?: { kind: "success" | "error"; text: string },
): string {
  const approvalControls =
    canApprove && order.status === "PENDING_APPROVAL"
      ? `<form method="post" action="/orders/${order.id}/approve" style="max-width:none">
          <button type="submit" data-testid="approve-button">审批通过</button>
        </form>
        <form method="post" action="/orders/${order.id}/reject" style="max-width:none">
          <label for="rejectReason">驳回原因</label>
          <input id="rejectReason" name="reason" data-testid="reject-reason-input">
          <button type="submit" class="danger" data-testid="reject-button">驳回</button>
        </form>`
      : "";
  return layout(
    `采购单 ${order.id}`,
    user,
    `${message ? `<div class="${message.kind}" data-testid="${message.kind}-message">${message.text}</div>` : ""}
    <h1>采购单详情</h1>
    <dl class="detail">
      <div><dt>单号</dt><dd data-testid="order-id">${order.id}</dd></div>
      <div><dt>标题</dt><dd data-testid="order-title">${order.title}</dd></div>
      <div><dt>金额</dt><dd><span data-testid="order-amount-cents">${order.amount_cents}</span> 分（${centsToYuanDisplay(order.amount_cents)} 元）</dd></div>
      <div><dt>状态</dt><dd><span class="status status-${order.status}" data-testid="order-status">${STATUS_LABEL[order.status]}</span></dd></div>
      <div><dt>备注</dt><dd>${order.note ?? "—"}</dd></div>
      <div><dt>创建时间</dt><dd>${order.created_at}</dd></div>
      ${order.submitted_at ? `<div><dt>提交时间</dt><dd>${order.submitted_at}</dd></div>` : ""}
      ${order.approved_at ? `<div><dt>审批时间</dt><dd>${order.approved_at}</dd></div>` : ""}
      ${order.rejected_reason ? `<div><dt>驳回原因</dt><dd>${order.rejected_reason}</dd></div>` : ""}
    </dl>
    ${order.status === "DRAFT" ? `<form method="post" action="/orders/${order.id}/submit">
      <button type="submit" data-testid="submit-button">提交审批</button>
    </form>` : ""}
    ${approvalControls}
    <p><a href="/orders" data-testid="back-to-orders">返回列表</a></p>`,
  );
}

export function paymentsPage(
  user: { displayName: string; role: "applicant" | "supervisor" },
  orders: DemoOrder[],
): string {
  const rows = orders
    .map(
      (o) => `<tr>
      <td data-testid="payment-order-id-${o.id}">${o.id}</td>
      <td>${o.title}</td>
      <td data-testid="payment-amount-${o.id}">${centsToYuanDisplay(o.amount_cents)} 元（${o.amount_cents} 分）</td>
      <td>${o.approved_at ?? "—"}</td>
    </tr>`,
    )
    .join("");
  return layout(
    "付款待办",
    user,
    `<h1>付款待办</h1>
    <p>当前范围付款待办数量：<span data-testid="payments-count">${orders.length}</span></p>
    <table data-testid="payments-table">
      <thead><tr><th>单号</th><th>标题</th><th>金额</th><th>进入待办时间</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='4'>暂无付款待办</td></tr>"}</tbody>
    </table>`,
  );
}

export function errorPage(
  user: { displayName: string; role: "applicant" | "supervisor" } | null,
  status: number,
  message: string,
): string {
  return layout(
    "错误",
    user,
    `<h1>操作失败</h1>
    <div class="error" data-testid="error-message">${message}</div>
    <p><a href="/orders" data-testid="back-to-orders">返回列表</a></p>`,
  );
}
