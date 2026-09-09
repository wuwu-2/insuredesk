import type { Permission, TicketCreateInput } from "@insuredesk/shared";
import { TICKET_SOURCES } from "@insuredesk/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient, User } from "../src/generated/prisma/client.ts";
import { listTickets } from "../src/services/ticket.service.ts";
import {
  createComplaintTickets,
  type IntegrationHarness,
  startIntegrationHarness,
} from "./integration-harness.ts";

const HOUR_MS = 60 * 60 * 1000;

describe("ticket list (Testcontainers)", () => {
  let harness: IntegrationHarness;
  let prisma: PrismaClient;
  let seeded: IntegrationHarness["seeded"];
  let complaintKindId: string;
  let refundKindId: string;

  beforeAll(async () => {
    harness = await startIntegrationHarness({
      seed: ["rolesAndUsers", "slaPolicies", "channels", "categories"],
      traceId: "ticket-list-test",
    });
    prisma = harness.prisma;
    seeded = harness.seeded;
    complaintKindId = (await prisma.ticketKind.findUniqueOrThrow({ where: { key: "complaint" } }))
      .id;
    refundKindId = (
      await prisma.ticketKind.findUniqueOrThrow({ where: { key: "refund_exception" } })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  // Every test builds its own fixture set from a clean slate, so counts and
  // orderings are exact (ProcessLogs cascade with their tickets).
  beforeEach(async () => {
    await prisma.ticket.deleteMany();
  });

  const callerWith = (user: User, permissions: Permission[]) =>
    harness.callerWith(user, seeded.roles.frontline, permissions);

  const manager = () => harness.callerFor(seeded.users.manager, seeded.roles.csManager);
  const frontline = () => harness.callerFor(seeded.users.cs1, seeded.roles.frontline);
  const observer = () => harness.callerFor(seeded.users.observer, seeded.roles.readOnly);

  const channelId = (name: string) => harness.channelId(name);
  const categoryId = (name: string) => harness.categoryId(name);
  const policyId = (name: string) => harness.slaPolicyId(name);

  const baseInput = () =>
    ({
      feedbackTime: "2026-07-09T02:00:00.000Z",
      project: "融盛",
      brokerageEntity: "东方大地",
      paymentChannel: "连连支付",
      policyNumbers: ["P2026070900123"],
      userFeedbackChannelId: null,
      customerName: "王小明",
      phone: "13800000000",
      customerRequest: "对保费收取金额有异议，要求核实并回复",
      nuclearBodyStatus: "待核实",
      hasContacted: false,
      slaPolicyId: policyId("一般投诉"),
      allowDuplicate: true,
    }) satisfies TicketCreateInput & { allowDuplicate?: boolean };

  async function makeTicket(
    input: Partial<TicketCreateInput> = {},
    row: Prisma.TicketUncheckedUpdateInput = {},
  ) {
    const created = await manager().ticket.create({
      ...baseInput(),
      channelId: channelId("保司"),
      ...input,
    });
    if (Object.keys(row).length > 0) {
      await prisma.ticket.update({ where: { id: created.id }, data: row });
    }
    return created;
  }

  describe("basic listing", () => {
    it("returns non-deleted tickets, newest created first by default, with a total count", async () => {
      const first = await makeTicket({ customerName: "客户一" });
      const second = await makeTicket({ customerName: "客户二" });
      const third = await makeTicket({ customerName: "客户三" });

      const result = await manager().ticket.list({});

      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.items.map((t) => t.id)).toEqual([third.id, second.id, first.id]);

      const item = result.items[0];
      expect(item?.workOrderNumber).toBe(third.workOrderNumber);
      expect(item?.customerName).toBe("客户三");
      expect(item?.channel).toBe("保司");
      expect(item?.slaPolicyId).toBe(policyId("一般投诉"));
      expect(item?.slaPolicyName).toBe("一般投诉");
      expect(item?.source).toBe("manual");
      expect(item?.createdBy).toBe("李主管");
      expect(item?.status).toBe("unassigned");
      // Fresh 一般投诉 is 48h from due — no computed override
      expect(item?.displayStatus).toBe("unassigned");
      expect(item?.assigneeName).toBeNull();
      expect(item && "deletedAt" in item).toBe(false);
    });

    it.each([
      { source: "manual", expected: "李主管" },
      { source: "file_import", expected: "李主管" },
      { source: "external_channel", expected: "李主管" },
      { source: "feishu_form", expected: "飞书" },
      { source: "community", expected: "社区" },
      { source: "jb-insurance", expected: "骏伯保险平台" },
    ])("$source 创建人显示 $expected，与详情一致", async ({ source, expected }) => {
      const ticket = await makeTicket({}, { source });
      const result = await manager().ticket.list({ source: [] });
      const detail = await manager().ticket.detail({ id: ticket.id });

      expect(result.items[0]?.createdBy).toBe(expected);
      expect(result.items[0]?.createdBy).toBe(detail.createdBy);
    });

    it("创建人缺失时返回 null", async () => {
      await makeTicket({}, { creatorId: null });
      const result = await manager().ticket.list({});
      expect(result.items[0]?.createdBy).toBeNull();
    });

    it("创建人改名后显示当前姓名", async () => {
      await makeTicket();
      const creator = seeded.users.manager;
      try {
        await prisma.user.update({ where: { id: creator.id }, data: { name: "李主管（新姓名）" } });
        const result = await manager().ticket.list({});
        expect(result.items[0]?.createdBy).toBe("李主管（新姓名）");
      } finally {
        await prisma.user.update({ where: { id: creator.id }, data: { name: creator.name } });
      }
    });

    it("默认排除软删工单 — soft-deleted rows appear in neither items nor total", async () => {
      const kept = await makeTicket();
      await makeTicket({}, { deletedAt: new Date() });

      const result = await manager().ticket.list({});

      expect(result.total).toBe(1);
      expect(result.items.map((t) => t.id)).toEqual([kept.id]);
    });
  });

  describe("status filter with computed statuses", () => {
    it("resolves pending_timeout / overdue as read-time predicates without touching stored status", async () => {
      const now = Date.now();
      const overdue = await makeTicket(
        { customerName: "已超时客户" },
        {
          status: "processing",
          dueAt: new Date(now - HOUR_MS),
        },
      );
      const pending = await makeTicket(
        { customerName: "待超时客户" },
        {
          status: "assigned",
          assigneeId: seeded.users.cs1.id,
          dueAt: new Date(now + HOUR_MS),
        },
      );
      const safe = await makeTicket({ customerName: "正常客户" });

      const overdueResult = await manager().ticket.list({ status: "overdue" });
      expect(overdueResult.items.map((t) => t.id)).toEqual([overdue.id]);
      expect(overdueResult.items[0]?.displayStatus).toBe("overdue");
      expect(overdueResult.items[0]?.status).toBe("processing");

      const pendingResult = await manager().ticket.list({ status: "pending_timeout" });
      expect(pendingResult.items.map((t) => t.id)).toEqual([pending.id]);
      expect(pendingResult.items[0]?.displayStatus).toBe("pending_timeout");

      const storedStatuses = await prisma.ticket.findMany({
        where: { id: { in: [overdue.id, pending.id, safe.id] } },
        select: { status: true },
      });
      expect(storedStatuses.map((t) => t.status).sort()).toEqual([
        "assigned",
        "processing",
        "unassigned",
      ]);
    });

    it("filtering a base status excludes rows a computed status overrides", async () => {
      const now = Date.now();
      await makeTicket(
        { customerName: "处理中已超时" },
        {
          status: "processing",
          dueAt: new Date(now - HOUR_MS),
        },
      );
      const calm = await makeTicket(
        { customerName: "处理中正常" },
        {
          status: "processing",
          dueAt: new Date(now + 30 * HOUR_MS),
        },
      );

      const result = await manager().ticket.list({ status: "processing" });
      expect(result.items.map((t) => t.id)).toEqual([calm.id]);
    });

    it("完结即移出 — a completed ticket past dueAt is completed, never overdue", async () => {
      const now = Date.now();
      const done = await makeTicket(
        { customerName: "超时后完结" },
        {
          status: "completed",
          dueAt: new Date(now - HOUR_MS),
          completionTime: new Date(now - HOUR_MS / 2),
        },
      );

      expect((await manager().ticket.list({ status: "overdue" })).total).toBe(0);

      const completedResult = await manager().ticket.list({ status: "completed" });
      expect(completedResult.items.map((t) => t.id)).toEqual([done.id]);
      expect(completedResult.items[0]?.displayStatus).toBe("completed");
    });

    it("特急永不 overdue — no dueAt means no computed status, however old the ticket", async () => {
      const now = Date.now();
      const urgent = await makeTicket(
        { slaPolicyId: policyId("特急投诉") },
        {
          createdAt: new Date(now - 100 * HOUR_MS),
        },
      );

      expect((await manager().ticket.list({ status: "overdue" })).total).toBe(0);
      expect((await manager().ticket.list({ status: "pending_timeout" })).total).toBe(0);

      const result = await manager().ticket.list({ status: "unassigned" });
      expect(result.items.map((t) => t.id)).toEqual([urgent.id]);
      expect(result.items[0]?.displayStatus).toBe("unassigned");
    });
  });

  describe("computed-status boundaries at exactly 2h / dueAt (fixed clock)", () => {
    it("agrees with deriveDisplayStatus on both edges of the window", async () => {
      const fixedNow = new Date();
      const viewer = harness.authUserFor(seeded.users.manager, seeded.roles.csManager);
      const list = (status: "assigned" | "pending_timeout" | "overdue") =>
        listTickets(harness.depsAt(fixedNow), viewer, {
          status: [status],
          source: [...TICKET_SOURCES],
          sortBy: "createdAt",
          sortOrder: "desc",
          page: 1,
          pageSize: 20,
        });

      const at = (offsetMs: number) => new Date(fixedNow.getTime() + offsetMs);
      const exactlyTwoHours = await makeTicket(
        { customerName: "整两小时" },
        {
          status: "assigned",
          dueAt: at(2 * HOUR_MS),
        },
      );
      const justInsideWindow = await makeTicket(
        { customerName: "差一毫秒两小时" },
        {
          status: "assigned",
          dueAt: at(2 * HOUR_MS - 1),
        },
      );
      const exactlyDue = await makeTicket(
        { customerName: "恰在时限" },
        {
          status: "assigned",
          dueAt: fixedNow,
        },
      );
      const justPastDue = await makeTicket(
        { customerName: "刚过时限" },
        {
          status: "assigned",
          dueAt: at(-1),
        },
      );

      // 不足 2 小时 is strict: exactly 2h left is still the base status
      expect((await list("assigned")).items.map((t) => t.id)).toEqual([exactlyTwoHours.id]);

      // 已超过 is strict: at the dueAt instant the ticket is pending, not overdue
      const pendingIds = (await list("pending_timeout")).items.map((t) => t.id);
      expect(pendingIds).toHaveLength(2);
      expect(pendingIds).toContain(justInsideWindow.id);
      expect(pendingIds).toContain(exactlyDue.id);

      expect((await list("overdue")).items.map((t) => t.id)).toEqual([justPastDue.id]);
    });
  });

  describe("channel / 时效策略 / source filters", () => {
    it("filters by each dimension and combines them", async () => {
      const payment = await makeTicket({
        channelId: channelId("支付"),
        slaPolicyId: policyId("高级投诉"),
      });
      const regulator = await makeTicket({
        channelId: channelId("监管"),
        slaPolicyId: policyId("高级投诉"),
      });
      await makeTicket({ channelId: channelId("保司"), slaPolicyId: policyId("一般投诉") });

      expect(
        (await manager().ticket.list({ channelId: channelId("支付") })).items.map((t) => t.id),
      ).toEqual([payment.id]);

      const highPolicy = await manager().ticket.list({ slaPolicyId: policyId("高级投诉") });
      expect(highPolicy.items.map((t) => t.id).sort()).toEqual([payment.id, regulator.id].sort());

      const combined = await manager().ticket.list({
        channelId: channelId("监管"),
        slaPolicyId: policyId("高级投诉"),
      });
      expect(combined.items.map((t) => t.id)).toEqual([regulator.id]);
    });

    it("时效策略筛选：多选取并集；旧 complaintLevel 筛选返回明确校验错误", async () => {
      const high = await makeTicket({ slaPolicyId: policyId("高级投诉") });
      const normal = await makeTicket({ slaPolicyId: policyId("一般投诉") });
      await makeTicket({ slaPolicyId: policyId("加急投诉") });

      const viaId = await manager().ticket.list({ slaPolicyId: policyId("高级投诉") });
      expect(viaId.items.map((t) => t.id)).toEqual([high.id]);
      expect(viaId.items[0]?.slaPolicyId).toBe(policyId("高级投诉"));

      const union = await manager().ticket.list({
        slaPolicyId: [policyId("高级投诉"), policyId("一般投诉")],
      });
      expect(union.items.map((t) => t.id).sort()).toEqual([high.id, normal.id].sort());

      for (const legacy of ["高级投诉", ["高级投诉", "一般投诉"]]) {
        const error = await manager()
          .ticket.list({ complaintLevel: legacy } as never)
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "BAD_REQUEST" });
        expect((error as Error).message).toContain("投诉等级文本轨已下线");
      }
    });

    it("filters by source — external rows surface once integrations write them", async () => {
      await makeTicket();
      const feishu = await makeTicket({}, { source: "feishu_form", creatorId: null });

      const result = await manager().ticket.list({ source: "feishu_form" });
      expect(result.items.map((t) => t.id)).toEqual([feishu.id]);
      expect(result.items[0]?.source).toBe("feishu_form");
    });
  });

  describe("种类筛选", () => {
    it("kindId 命中对应种类；多选取并集；缺省不过滤", async () => {
      const complaint = await makeTicket({ customerName: "投诉客户" });
      const refund = await makeTicket(
        { customerName: "退费客户" },
        { kindId: refundKindId, source: "jb-insurance", creatorId: null },
      );

      expect((await manager().ticket.list({})).total).toBe(2);

      const refunds = await manager().ticket.list({ kindId: refundKindId });
      expect(refunds.items.map((t) => t.id)).toEqual([refund.id]);

      const complaints = await manager().ticket.list({ kindId: complaintKindId });
      expect(complaints.items.map((t) => t.id)).toEqual([complaint.id]);

      const union = await manager().ticket.list({ kindId: [refundKindId, complaintKindId] });
      expect(union.total).toBe(2);
    });
  });

  describe("保单号状态筛选", () => {
    it("policyNumberState=[none] 只命中「无保单号」工单，留空与已填都不命中", async () => {
      const none = await makeTicket({ policyNumbers: [], noPolicyNumber: true });
      await makeTicket({ policyNumbers: [] });
      await makeTicket();

      const result = await manager().ticket.list({ policyNumberState: ["none"] });
      expect(result.total).toBe(1);
      expect(result.items[0]?.id).toBe(none.id);
      expect(result.items[0]?.noPolicyNumber).toBe(true);
    });
  });

  describe("责任人筛选", () => {
    it("assigneeId 命中对应责任人；多选取并集；旧单值宽容接受；缺省不过滤", async () => {
      const zhang = await makeTicket(
        { customerName: "张客服的单" },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      const li = await makeTicket(
        { customerName: "主管的单" },
        { status: "assigned", assigneeId: seeded.users.manager.id, assignedAt: new Date() },
      );
      await makeTicket({ customerName: "未分配" });

      expect((await manager().ticket.list({})).total).toBe(3);

      const own = await manager().ticket.list({ assigneeId: seeded.users.cs1.id });
      expect(own.items.map((t) => t.id)).toEqual([zhang.id]);

      const union = await manager().ticket.list({
        assigneeId: [seeded.users.cs1.id, seeded.users.manager.id],
      });
      expect(union.items.map((t) => t.id).sort()).toEqual([zhang.id, li.id].sort());

      const single = await manager().ticket.list({ assigneeId: seeded.users.cs1.id as never });
      expect(single.items.map((t) => t.id)).toEqual([zhang.id]);
    });

    it("data scope 与 assigneeId 筛选 AND 叠加 — scope 钉住的可见集不被筛选放宽", async () => {
      const creator = () => callerWith(seeded.users.cs1, ["ticket.view", "ticket.create"]);
      // cs1 名下（经 assigneeId 入 scope）
      await makeTicket(
        { customerName: "cs1 名下" },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      // cs1 创建、主管名下（经 creatorId 入 scope）
      const createdByMe = await creator().ticket.create({
        ...baseInput(),
        customerName: "我创建主管处理",
      });
      await manager().ticket.assign({
        ticketId: createdByMe.id,
        assigneeId: seeded.users.manager.id,
      });
      // 与 cs1 无关的主管单（不在 scope）
      await makeTicket(
        { customerName: "主管自己的单" },
        { status: "assigned", assigneeId: seeded.users.manager.id, assignedAt: new Date() },
      );

      const scoped = await frontline().ticket.list({ assigneeId: seeded.users.manager.id });
      expect(scoped.items.map((t) => t.id)).toEqual([createdByMe.id]);
    });
  });

  describe("待首响筛选 (firstResponse=pending)", () => {
    it("命中 assigned/processing 且零次联系；未分配、已联系、已完结都不命中", async () => {
      const assigned = await makeTicket(
        { customerName: "已分配未联系" },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      const processing = await makeTicket(
        { customerName: "处理中未联系" },
        { status: "processing", assigneeId: seeded.users.cs1.id },
      );
      // 未分配即使零次联系也不算待首响（与待办/dashboard 同口径）
      await makeTicket({ customerName: "未分配" });
      await makeTicket(
        { customerName: "已联系" },
        { status: "processing", assigneeId: seeded.users.cs1.id, contactCount: 1 },
      );
      await makeTicket(
        { customerName: "已完结" },
        { status: "completed", completionTime: new Date() },
      );

      const result = await manager().ticket.list({ firstResponse: "pending" });
      expect(result.items.map((t) => t.id).sort()).toEqual([assigned.id, processing.id].sort());
    });

    it("与责任人筛选叠加取交集", async () => {
      const mine = await makeTicket(
        { customerName: "我的待首响" },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      await makeTicket(
        { customerName: "主管的待首响" },
        { status: "assigned", assigneeId: seeded.users.manager.id, assignedAt: new Date() },
      );

      const result = await manager().ticket.list({
        firstResponse: "pending",
        assigneeId: seeded.users.cs1.id,
      });
      expect(result.items.map((t) => t.id)).toEqual([mine.id]);
    });
  });

  describe("slaPolicyId=none 筛选", () => {
    it("none 命中未指定策略的工单；与真实 id 混合时取并集", async () => {
      const noPolicy = await makeTicket({ customerName: "未定级", slaPolicyId: null });
      const normal = await makeTicket({ customerName: "一般" });
      const high = await makeTicket({ customerName: "高级", slaPolicyId: policyId("高级投诉") });

      const noneOnly = await manager().ticket.list({ slaPolicyId: ["none"] });
      expect(noneOnly.items.map((t) => t.id)).toEqual([noPolicy.id]);

      const mixed = await manager().ticket.list({ slaPolicyId: ["none", policyId("高级投诉")] });
      expect(mixed.items.map((t) => t.id).sort()).toEqual([noPolicy.id, high.id].sort());

      const realOnly = await manager().ticket.list({ slaPolicyId: [policyId("一般投诉")] });
      expect(realOnly.items.map((t) => t.id)).toEqual([normal.id]);
    });

    it("三个新筛选维度叠加取交集", async () => {
      const hit = await makeTicket(
        { customerName: "三条件全中", slaPolicyId: null },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      // 策略不符（有指定策略）
      await makeTicket(
        { customerName: "有策略" },
        { status: "assigned", assigneeId: seeded.users.cs1.id, assignedAt: new Date() },
      );
      // 已首响
      await makeTicket(
        { customerName: "已联系", slaPolicyId: null },
        { status: "processing", assigneeId: seeded.users.cs1.id, contactCount: 2 },
      );
      // 责任人不符
      await makeTicket(
        { customerName: "主管的", slaPolicyId: null },
        { status: "assigned", assigneeId: seeded.users.manager.id, assignedAt: new Date() },
      );

      const result = await manager().ticket.list({
        assigneeId: [seeded.users.cs1.id],
        firstResponse: "pending",
        slaPolicyId: ["none"],
      });
      expect(result.items.map((t) => t.id)).toEqual([hit.id]);
    });
  });

  describe("multi-select filters", () => {
    it("multi-value filters take the union within a dimension, intersect across dimensions", async () => {
      const payHigh = await makeTicket({
        channelId: channelId("支付"),
        slaPolicyId: policyId("高级投诉"),
      });
      const regulatorHigh = await makeTicket({
        channelId: channelId("监管"),
        slaPolicyId: policyId("高级投诉"),
      });
      const payLow = await makeTicket({
        channelId: channelId("支付"),
        slaPolicyId: policyId("一般投诉"),
      });
      await makeTicket({ channelId: channelId("保司"), slaPolicyId: policyId("一般投诉") });

      const channels = await manager().ticket.list({
        channelId: [channelId("支付"), channelId("监管")],
      });
      expect(channels.items.map((t) => t.id).sort()).toEqual(
        [payHigh.id, regulatorHigh.id, payLow.id].sort(),
      );

      const levels = await manager().ticket.list({
        slaPolicyId: [policyId("高级投诉"), policyId("一般投诉")],
        channelId: [channelId("支付")],
      });
      expect(levels.items.map((t) => t.id).sort()).toEqual([payHigh.id, payLow.id].sort());
    });

    it("multi-select 状态 takes the union of each status's predicate", async () => {
      const now = Date.now();
      const overdue = await makeTicket(
        {},
        { status: "processing", dueAt: new Date(now - HOUR_MS) },
      );
      const done = await makeTicket(
        {},
        { status: "completed", completionTime: new Date(now - HOUR_MS / 2) },
      );
      await makeTicket({});

      const result = await manager().ticket.list({ status: ["overdue", "completed"] });
      expect(result.items.map((t) => t.id).sort()).toEqual([overdue.id, done.id].sort());
    });

    it("empty selection arrays filter nothing", async () => {
      await makeTicket();
      await makeTicket();

      const result = await manager().ticket.list({ status: [], channelId: [], slaPolicyId: [] });
      expect(result.total).toBe(2);
    });

    it("旧单值参数仍被宽容接受 — single values behave as one-element selections", async () => {
      await makeTicket({ channelId: channelId("保司") });
      const payment = await makeTicket({ channelId: channelId("支付") });

      const result = await manager().ticket.list({ channelId: channelId("支付") as never });
      expect(result.items.map((t) => t.id)).toEqual([payment.id]);
    });
  });

  describe("归档工单 (source=file_import) 默认隐藏", () => {
    it("default query excludes file_import rows, explicit source selections include them", async () => {
      const active = await makeTicket();
      const archived = await makeTicket({}, { source: "file_import" });

      // 缺省 = 排除 file_import；导出复用同一 WHERE，同样不含归档单
      const defaulted = await manager().ticket.list({});
      expect(defaulted.items.map((t) => t.id)).toEqual([active.id]);

      const explicit = await manager().ticket.list({ source: ["file_import"] });
      expect(explicit.items.map((t) => t.id)).toEqual([archived.id]);

      const cleared = await manager().ticket.list({ source: [] });
      expect(cleared.items.map((t) => t.id).sort()).toEqual([active.id, archived.id].sort());

      const all = await manager().ticket.list({ source: [...TICKET_SOURCES] });
      expect(all.total).toBe(2);
    });

    it("jb-insurance 进默认来源筛选：推送单默认可见、可按来源单独筛出", async () => {
      const pushed = await makeTicket({}, { source: "jb-insurance" });
      await makeTicket();

      const defaulted = await manager().ticket.list({});
      expect(defaulted.items.map((t) => t.id)).toContain(pushed.id);

      const explicit = await manager().ticket.list({ source: ["jb-insurance"] });
      expect(explicit.items.map((t) => t.id)).toEqual([pushed.id]);
    });
  });

  describe("category filter", () => {
    it("filters by category, disabled categories included — 存量工单 stays reachable", async () => {
      const claims = await makeTicket({ categoryId: categoryId("理赔咨询") });
      const disabledCat = await makeTicket({ categoryId: categoryId("回访问题") });
      await makeTicket({ categoryId: categoryId("其他") });

      await prisma.ticketCategory.update({
        where: { id: categoryId("回访问题") },
        data: { active: false },
      });

      expect(
        (await manager().ticket.list({ categoryId: categoryId("理赔咨询") })).items.map(
          (t) => t.id,
        ),
      ).toEqual([claims.id]);

      expect(
        (await manager().ticket.list({ categoryId: categoryId("回访问题") })).items.map(
          (t) => t.id,
        ),
      ).toEqual([disabledCat.id]);
    });
  });

  describe("数据范围隔离", () => {
    it("without ticket.view_all the list is pinned to own tickets — the unassigned pool is invisible", async () => {
      await makeTicket({ customerName: "无人认领" });
      const own = await makeTicket(
        { customerName: "小李的单" },
        {
          status: "assigned",
          assigneeId: seeded.users.cs1.id,
          assignedAt: new Date(),
        },
      );
      const someoneElses = await makeTicket(
        { customerName: "主管的单" },
        {
          status: "assigned",
          assigneeId: seeded.users.manager.id,
          assignedAt: new Date(),
        },
      );

      const frontlineResult = await frontline().ticket.list({});
      expect(frontlineResult.total).toBe(1);
      expect(frontlineResult.items.map((t) => t.id)).toEqual([own.id]);

      for (const caller of [manager(), observer()]) {
        const all = await caller.ticket.list({});
        expect(all.total).toBe(3);
        expect(all.items.map((t) => t.id)).toContain(someoneElses.id);
      }
    });

    it("filters stay inside the viewer's scope, never widen it", async () => {
      await makeTicket({ channelId: channelId("支付"), customerName: "别人的支付单" });
      const own = await makeTicket(
        { channelId: channelId("支付"), customerName: "自己的支付单" },
        {
          status: "assigned",
          assigneeId: seeded.users.cs1.id,
        },
      );

      const result = await frontline().ticket.list({ channelId: channelId("支付") });
      expect(result.items.map((t) => t.id)).toEqual([own.id]);
    });

    it("创建人无 view_all 也能看到自己手工创建的单 — 未指派与已指派他人均可见", async () => {
      const creator = () => callerWith(seeded.users.cs1, ["ticket.view", "ticket.create"]);

      const unassignedOwn = await creator().ticket.create({
        ...baseInput,
        customerName: "我创建未指派",
      });
      const handedOff = await creator().ticket.create({
        ...baseInput,
        customerName: "我创建主管处理",
      });
      await manager().ticket.assign({
        ticketId: handedOff.id,
        assigneeId: seeded.users.manager.id,
      });
      await makeTicket({ customerName: "别人创建的" });

      const result = await creator().ticket.list({});
      expect(result.total).toBe(2);
      expect(result.items.map((t) => t.id).sort()).toEqual([unassignedOwn.id, handedOff.id].sort());

      const handedOffRow = result.items.find((t) => t.id === handedOff.id);
      expect(handedOffRow?.assigneeName).toBe(seeded.users.manager.name);

      const thirdParty = () => callerWith(seeded.users.observer, ["ticket.view"]);
      expect((await thirdParty().ticket.list({})).total).toBe(0);
    });
  });

  describe("search: 工单号 / 客户姓名 / 保单号 / 电话", () => {
    it("matches partial work-order number, customer name, and policy number", async () => {
      const zhang = await makeTicket({ customerName: "张三丰", policyNumbers: ["PA-88001"] });
      const li = await makeTicket({ customerName: "李四", policyNumbers: ["PB-99002"] });

      const byNumber = await manager().ticket.list({ search: zhang.workOrderNumber });
      expect(byNumber.items.map((t) => t.id)).toEqual([zhang.id]);

      const byName = await manager().ticket.list({ search: "三丰" });
      expect(byName.items.map((t) => t.id)).toEqual([zhang.id]);

      const alice = await makeTicket({ customerName: "Alice Wang", policyNumbers: ["PC-77003"] });
      const byLatinName = await manager().ticket.list({ search: "alice" });
      expect(byLatinName.items.map((t) => t.id)).toEqual([alice.id]);

      const byPolicy = await manager().ticket.list({ search: "99002" });
      expect(byPolicy.items.map((t) => t.id)).toEqual([li.id]);

      expect((await manager().ticket.list({ search: "毫无匹配" })).total).toBe(0);
    });

    it("matches phone (客户电话) and contactPhone (联系人电话) by substring", async () => {
      const withPhone = await makeTicket({
        customerName: "有客户电话",
        phone: "138-0000-0000",
        policyNumbers: [],
      });
      const withContact = await makeTicket({
        customerName: "有联系人电话",
        phone: null,
        policyNumbers: [],
        contactPhone: "13900001111",
      });
      const withBoth = await makeTicket({
        customerName: "两电话都有",
        phone: "15800000000",
        policyNumbers: [],
        contactPhone: "17600000000",
      });
      await makeTicket({
        customerName: "无电话",
        phone: null,
        policyNumbers: [],
        contactPhone: null,
      });

      const byPhone = await manager().ticket.list({ search: "138" });
      expect(byPhone.items.map((t) => t.id)).toEqual([withPhone.id]);

      const byContact = await manager().ticket.list({ search: "1390" });
      expect(byContact.items.map((t) => t.id)).toEqual([withContact.id]);

      const byBothPhone = await manager().ticket.list({ search: "158" });
      expect(byBothPhone.items.map((t) => t.id)).toEqual([withBoth.id]);

      const byBothContact = await manager().ticket.list({ search: "176" });
      expect(byBothContact.items.map((t) => t.id)).toEqual([withBoth.id]);

      expect((await manager().ticket.list({ search: "13800000000" })).total).toBe(0);

      expect((await manager().ticket.list({ search: "99999999" })).total).toBe(0);
    });

    it("联系人电话含多个号码时，搜其中任一个都能命中", async () => {
      const multiContact = await makeTicket({
        customerName: "多联系号码",
        phone: null,
        policyNumbers: [],
        contactPhone: "13900001111, 17600000000",
      });

      expect((await manager().ticket.list({ search: "1390" })).items.map((t) => t.id)).toEqual([
        multiContact.id,
      ]);
      expect((await manager().ticket.list({ search: "1760" })).items.map((t) => t.id)).toEqual([
        multiContact.id,
      ]);
    });

    it("电话搜索可与其他筛选维度叠加（交集）", async () => {
      const paymentWithPhone = await makeTicket({
        channelId: channelId("支付"),
        phone: "13800000000",
        policyNumbers: [],
      });
      await makeTicket({
        channelId: channelId("保司"),
        phone: "13800000000",
        policyNumbers: [],
      });
      await makeTicket({
        channelId: channelId("支付"),
        phone: "15900000000",
        policyNumbers: [],
      });

      const filtered = await manager().ticket.list({
        search: "138",
        channelId: [channelId("支付")],
      });
      expect(filtered.items.map((t) => t.id)).toEqual([paymentWithPhone.id]);
    });

    it("treats blank search as no search", async () => {
      await makeTicket();
      expect((await manager().ticket.list({ search: "   " })).total).toBe(1);
    });

    it("matches 保单号 by substring across multiple values, in their joined form", async () => {
      const multi = await makeTicket({ policyNumbers: ["PD-11001", "PE-22002"] });
      await makeTicket({ policyNumbers: [] });

      expect((await manager().ticket.list({ search: "22002" })).items.map((t) => t.id)).toEqual([
        multi.id,
      ]);
      expect((await manager().ticket.list({ search: "pe-22" })).items.map((t) => t.id)).toEqual([
        multi.id,
      ]);
      expect((await manager().ticket.list({ search: "11001 PE" })).items.map((t) => t.id)).toEqual([
        multi.id,
      ]);
    });
  });

  describe("创建时间区间筛选 (左闭右闭绝对时刻)", () => {
    async function rangeFixture() {
      const from = new Date("2026-07-06T00:00:00.000Z");
      const to = new Date("2026-07-12T23:59:59.999Z");
      return {
        from,
        to,
        before: await makeTicket({}, { createdAt: new Date(from.getTime() - 1) }),
        atFrom: await makeTicket({}, { createdAt: from }),
        atTo: await makeTicket({}, { createdAt: to }),
        after: await makeTicket({}, { createdAt: new Date(to.getTime() + 1) }),
      };
    }

    it("includes both edges and excludes the instants just outside them", async () => {
      const f = await rangeFixture();

      const result = await manager().ticket.list({
        createdFrom: f.from.toISOString(),
        createdTo: f.to.toISOString(),
      });
      expect(result.items.map((t) => t.id).sort()).toEqual([f.atFrom.id, f.atTo.id].sort());
    });

    it("accepts an open-ended range on either side", async () => {
      const f = await rangeFixture();

      const fromOnly = await manager().ticket.list({ createdFrom: f.from.toISOString() });
      expect(fromOnly.items.map((t) => t.id).sort()).toEqual(
        [f.atFrom.id, f.atTo.id, f.after.id].sort(),
      );

      const toOnly = await manager().ticket.list({ createdTo: f.to.toISOString() });
      expect(toOnly.items.map((t) => t.id).sort()).toEqual(
        [f.before.id, f.atFrom.id, f.atTo.id].sort(),
      );
    });

    it("无区间参数 = 不按创建时间筛选", async () => {
      const f = await rangeFixture();
      expect((await manager().ticket.list({})).total).toBe(4);
      expect(f.before.id).toBeTruthy();
    });

    it("与其余筛选维度、搜索、排序、分页叠加取交集", async () => {
      const from = new Date("2026-07-06T00:00:00.000Z");
      const to = new Date("2026-07-12T23:59:59.999Z");
      const inRangePay = await makeTicket(
        { channelId: channelId("支付"), customerName: "区间内" },
        { createdAt: new Date("2026-07-08T02:00:00.000Z") },
      );
      // 同渠道同名但在区间外
      await makeTicket(
        { channelId: channelId("支付"), customerName: "区间内" },
        { createdAt: new Date("2026-07-20T02:00:00.000Z") },
      );
      // 区间内但另一渠道
      await makeTicket(
        { channelId: channelId("保司"), customerName: "区间内" },
        { createdAt: new Date("2026-07-09T02:00:00.000Z") },
      );

      const result = await manager().ticket.list({
        createdFrom: from.toISOString(),
        createdTo: to.toISOString(),
        channelId: [channelId("支付")],
        search: "区间内",
        sortBy: "createdAt",
        sortOrder: "asc",
        page: 1,
        pageSize: 20,
      });
      expect(result.items.map((t) => t.id)).toEqual([inRangePay.id]);
      expect(result.total).toBe(1);
    });

    it("起晚于止的区间选出空集，而不是报错", async () => {
      await makeTicket({}, { createdAt: new Date("2026-07-08T02:00:00.000Z") });

      const result = await manager().ticket.list({
        createdFrom: "2026-07-12T00:00:00.000Z",
        createdTo: "2026-07-06T00:00:00.000Z",
      });
      expect(result.total).toBe(0);
    });
  });

  describe("sort: 创建时间 / dueAt", () => {
    it("orders by createdAt in both directions", async () => {
      const now = Date.now();
      const oldest = await makeTicket({}, { createdAt: new Date(now - 3 * HOUR_MS) });
      const middle = await makeTicket({}, { createdAt: new Date(now - 2 * HOUR_MS) });
      const newest = await makeTicket({}, { createdAt: new Date(now - HOUR_MS) });

      const asc = await manager().ticket.list({ sortBy: "createdAt", sortOrder: "asc" });
      expect(asc.items.map((t) => t.id)).toEqual([oldest.id, middle.id, newest.id]);

      const desc = await manager().ticket.list({ sortBy: "createdAt", sortOrder: "desc" });
      expect(desc.items.map((t) => t.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it("orders by dueAt with 特急 (no dueAt) always last", async () => {
      const now = Date.now();
      const later = await makeTicket({}, { dueAt: new Date(now + 40 * HOUR_MS) });
      const sooner = await makeTicket({}, { dueAt: new Date(now + 10 * HOUR_MS) });
      const urgent = await makeTicket({ slaPolicyId: policyId("特急投诉") });

      const asc = await manager().ticket.list({ sortBy: "dueAt", sortOrder: "asc" });
      expect(asc.items.map((t) => t.id)).toEqual([sooner.id, later.id, urgent.id]);

      const desc = await manager().ticket.list({ sortBy: "dueAt", sortOrder: "desc" });
      expect(desc.items.map((t) => t.id)).toEqual([later.id, sooner.id, urgent.id]);
    });
  });

  describe("pagination", () => {
    it("slices stable pages and reports the filtered total", async () => {
      for (let i = 0; i < 5; i++) {
        await makeTicket({ customerName: `分页客户${i}` });
      }

      const page1 = await manager().ticket.list({ pageSize: 2, page: 1 });
      const page2 = await manager().ticket.list({ pageSize: 2, page: 2 });
      const page3 = await manager().ticket.list({ pageSize: 2, page: 3 });

      expect(page1.total).toBe(5);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page3.items).toHaveLength(1);

      const seen = [...page1.items, ...page2.items, ...page3.items].map((t) => t.id);
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe("performance", () => {
    it("loads 100 rows in under 1 second", async () => {
      const now = Date.now();
      await createComplaintTickets(
        prisma,
        Array.from({ length: 120 }, (_, i) => ({
          core: {
            kindId: complaintKindId,
            createdAt: new Date(now - i * 60_000),
            slaPolicyId: policyId("一般投诉"),
            dueAt: new Date(now + (i - 60) * HOUR_MS),
            followUpFrequency: "24小时内累计跟进1次；48小时内累计跟进2次",
            firstResponseRequirement: "120分钟内完成首次响应",
          },
          detail: {
            feedbackTime: new Date(now - i * 60_000),
            channelId: channelId("保司"),
            project: "融盛",
            brokerageEntity: "东方大地",
            paymentChannel: "连连支付",
            policyNumbers: [`P-${i}`],
            userFeedbackChannelId: null,
            customerName: `压测客户${i}`,
            phone: "13800000000",
            customerRequest: "压测数据",
            nuclearBodyStatus: "待核实",
            hasContacted: false,
          },
        })),
      );

      const startedAt = performance.now();
      const result = await manager().ticket.list({ pageSize: 100 });
      const elapsedMs = performance.now() - startedAt;

      expect(result.items).toHaveLength(100);
      expect(result.total).toBe(120);
      expect(elapsedMs).toBeLessThan(1000);
    });
  });
});
