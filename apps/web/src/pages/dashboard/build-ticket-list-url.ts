import { TICKET_DISPLAY_STATUSES } from "@insuredesk/shared";

/**
 * 看板下钻链接只拼实时口径参数（status/firstResponse/slaPolicyId），不带
 * createdRange——行动区与策略区是当前快照，周期筛选交给列表页自己叠加。
 * slaPolicyId 的字面值 "none" = 未指定策略（契约见 shared/ticket-filter.ts）。
 */

// 6 个展示状态互斥划分全集，剔除 completed 后与策略卡「在途」数字严格同口径。
const OPEN_STATUSES = TICKET_DISPLAY_STATUSES.filter((s) => s !== "completed");

type ActionStatus = "overdue" | "pending_timeout" | "unassigned";

export function buildStatusTicketListUrl(status: ActionStatus): string {
  return `/tickets?status=${status}`;
}

export function buildFirstResponseTicketListUrl(): string {
  return "/tickets?firstResponse=pending";
}

export function buildPolicyTicketListUrl(
  policyId: string | null,
  status?: "overdue" | "pending_timeout",
): string {
  const slaPolicyId = policyId ?? "none";
  return `/tickets?slaPolicyId=${slaPolicyId}&status=${status ?? OPEN_STATUSES.join(",")}`;
}
