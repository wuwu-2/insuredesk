import { describe, expect, it } from "vitest";
import {
  buildFirstResponseTicketListUrl,
  buildPolicyTicketListUrl,
  buildStatusTicketListUrl,
} from "./build-ticket-list-url";

describe("buildStatusTicketListUrl", () => {
  it("overdue card links to status=overdue", () => {
    expect(buildStatusTicketListUrl("overdue")).toBe("/tickets?status=overdue");
  });

  it("due-soon card links to status=pending_timeout", () => {
    expect(buildStatusTicketListUrl("pending_timeout")).toBe("/tickets?status=pending_timeout");
  });

  it("unassigned card links to status=unassigned", () => {
    expect(buildStatusTicketListUrl("unassigned")).toBe("/tickets?status=unassigned");
  });
});

describe("buildFirstResponseTicketListUrl", () => {
  it("links to firstResponse=pending", () => {
    expect(buildFirstResponseTicketListUrl()).toBe("/tickets?firstResponse=pending");
  });
});

const OPEN_STATUS_QUERY = "unassigned,assigned,processing,pending_timeout,overdue";

describe("buildPolicyTicketListUrl", () => {
  it("policy card links to its slaPolicyId scoped to open tickets", () => {
    expect(buildPolicyTicketListUrl("pol-1")).toBe(
      `/tickets?slaPolicyId=pol-1&status=${OPEN_STATUS_QUERY}`,
    );
  });

  it("null policy id maps to the literal none bucket", () => {
    expect(buildPolicyTicketListUrl(null)).toBe(
      `/tickets?slaPolicyId=none&status=${OPEN_STATUS_QUERY}`,
    );
  });

  it("overdue drill-down appends status=overdue", () => {
    expect(buildPolicyTicketListUrl("pol-1", "overdue")).toBe(
      "/tickets?slaPolicyId=pol-1&status=overdue",
    );
  });

  it("due-soon drill-down on the none bucket keeps both params", () => {
    expect(buildPolicyTicketListUrl(null, "pending_timeout")).toBe(
      "/tickets?slaPolicyId=none&status=pending_timeout",
    );
  });
});
