import {
  applyNoPolicyNumber,
  CALLBACK_DELIVERY_STATUSES,
  deriveDisplayStatus,
  formatFirstResponseRequirement,
  formatFollowUpFrequency,
  isCreatorBackedSource,
  nuclearBodyStatusSchema,
  prioritySchema,
  processLogActionSchema,
  refundTradePushSchema,
  reminderRulesSchema,
  substringSearchPattern,
  TICKET_CREATE_FIELD_KEYS,
  TICKET_FIELDS,
  TICKET_SOURCE_LABELS,
  type TicketCreateData,
  type TicketCreateFieldKey,
  TicketKindKey,
  type TicketListQuery,
  TicketStatus,
  ticketListFilterConditions,
  ticketSourceSchema,
  ticketStatusSchema,
} from "@insuredesk/shared";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import type { Prisma, PrismaClient, SlaPolicy } from "../generated/prisma/client.ts";
import type { AuthenticatedUser } from "./auth.service.ts";
import { channelCatalog } from "./channel.service.ts";
import { applyTicketDataScope } from "./data-scope.service.ts";
import { feedbackReceiveChannelCatalog } from "./feedback-receive-channel.service.ts";
import { ticketCategoryCatalog } from "./ticket-category.service.ts";
import { displayStatusTicketWhere } from "./ticket-display-status.ts";
import { assertNoDuplicateTickets } from "./ticket-duplicate.service.ts";
import { requireTicketKindId } from "./ticket-kind.service.ts";
import { userFeedbackChannelCatalog } from "./user-feedback-channel.service.ts";

export interface TicketServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
}

export class SlaPolicyNotConfiguredError extends Error {
  constructor(label: string) {
    super(`时效策略「${label}」缺少 SLA 策略配置或已停用`);
    this.name = "SlaPolicyNotConfiguredError";
  }
}

export class SlaPolicyKindMismatchError extends SlaPolicyNotConfiguredError {
  constructor(name: string) {
    super(name);
    this.name = "SlaPolicyKindMismatchError";
    this.message = `时效策略「${name}」不属于该工单的种类组`;
  }
}

export class RequiredFieldsMissingError extends Error {
  constructor(missingFields: string[]) {
    super(`以下字段为必填项：${missingFields.join("、")}`);
    this.name = "RequiredFieldsMissingError";
  }
}

const HOUR_MS = 60 * 60 * 1000;

export function toDateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * THE dueAt formula: slaAnchorAt + the policy's overdueHours, null when the
 * policy has no deadline. Creation stamps it; a 改策略引用 re-runs it with
 * the new policy's hours against the same unchanging slaAnchorAt.
 */
export function computeDueAt(slaAnchorAt: Date, overdueHours: number | null): Date | null {
  return overdueHours === null ? null : new Date(slaAnchorAt.getTime() + overdueHours * HOUR_MS);
}

/**
 * 解析策略引用到策略行。引用非空而查无此行 = 配置故障（抛
 * SlaPolicyNotConfiguredError）；停用行照常返回——是否接受停用由调用方按
 * 场景决定（写入拒绝，读侧降级）。
 */
export async function findSlaPolicyById(
  db: Pick<PrismaClient, "slaPolicy">,
  slaPolicyId: string | null,
): Promise<SlaPolicy | null> {
  if (slaPolicyId === null) {
    return null;
  }
  const policy = await db.slaPolicy.findUnique({ where: { id: slaPolicyId } });
  if (!policy) {
    throw new SlaPolicyNotConfiguredError(slaPolicyId);
  }
  return policy;
}

export async function resolveSlaPolicy(
  db: Pick<PrismaClient, "slaPolicy">,
  slaPolicyId: string | null,
  expectedKindId: string,
): Promise<SlaPolicy | null> {
  const policy = await findSlaPolicyById(db, slaPolicyId);
  if (policy !== null && !policy.active) {
    throw new SlaPolicyNotConfiguredError(policy.name);
  }
  if (policy !== null && policy.kindId !== expectedKindId) {
    throw new SlaPolicyKindMismatchError(policy.name);
  }
  return policy;
}

/**
 * The SLA fields a 时效策略引用 stamps onto a ticket. A null policy (未指定)
 * stamps all-null: no dueAt, no 首响/跟进 requirements — and hence no SLA time
 * alerts until an edit sets a reference (off the ticket's slaAnchorAt).
 */
export function stampFromPolicy(
  policy: SlaPolicy | null,
  slaAnchorAt: Date,
): {
  slaPolicyId: string | null;
  dueAt: Date | null;
  followUpFrequency: string | null;
  firstResponseRequirement: string | null;
} {
  if (policy === null) {
    return {
      slaPolicyId: null,
      dueAt: null,
      followUpFrequency: null,
      firstResponseRequirement: null,
    };
  }
  return {
    slaPolicyId: policy.id,
    dueAt: computeDueAt(slaAnchorAt, policy.overdueHours),
    followUpFrequency: formatFollowUpFrequency(reminderRulesSchema.parse(policy.reminderRules)),
    firstResponseRequirement: formatFirstResponseRequirement(policy.firstResponseMinutes),
  };
}

export async function computeSlaStamp(
  db: Pick<PrismaClient, "slaPolicy">,
  slaPolicyId: string | null,
  slaAnchorAt: Date,
  expectedKindId: string,
) {
  return stampFromPolicy(await resolveSlaPolicy(db, slaPolicyId, expectedKindId), slaAnchorAt);
}

/**
 * 校验角色建单必填字段集：每项属于清单且值非空（三态字段必须明确选是/否，
 * 多值字段的空数组＝未填写）。缺失字段一次性全部报出，字段名＝描述表标准名
 * （与表单可见 label 对上）。读取时忽略未知 key（防御字段改名）。
 */
function validateRequiredFields(input: TicketCreateData, requiredFields: string[]): void {
  const missingLabels: string[] = [];
  for (const field of requiredFields) {
    if (!TICKET_CREATE_FIELD_KEYS.includes(field as TicketCreateFieldKey)) {
      continue;
    }
    // 「无保单号」是明确表态，不算未填写
    if (field === "policyNumbers" && input.noPolicyNumber) {
      continue;
    }
    const value = input[field as TicketCreateFieldKey];
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      missingLabels.push(TICKET_FIELDS[field as TicketCreateFieldKey].label);
    }
  }
  if (missingLabels.length > 0) {
    throw new RequiredFieldsMissingError(missingLabels);
  }
}

export function complaintDetailData(
  data: TicketCreateData,
): Omit<TicketCreateData, "contactPhone" | "slaPolicyId" | "complaintLevel"> {
  const {
    contactPhone: _corePhone,
    slaPolicyId: _corePolicy,
    complaintLevel: _legacy,
    ...detail
  } = data;
  return detail;
}

/**
 * Create a manually-entered ticket:
 *
 * - every user field is optional: a fully blank submission is valid,
 *   unfilled fields persist as NULL ("unknown", never "")
 * - requiredTicketFields of creator's role: missing any → reject with all missing fields
 * - workOrderNumber comes from the Postgres sequence default (concurrency-safe)
 * - 手工建单只产投诉单：kind 盖投诉、slaAnchorAt = createdAt；dueAt fixed
 *   once, here: anchor + the policy's overdueHours
 *   (null for 特急 — never overdue; null while 未定级 — no SLA clock fields)
 * - 跟进频次/首响要求 are stamped from the policy's SLA config, not hardcoded
 * - source=manual records creatorId; "由谁创建" derives at read time
 * - the first `create` ProcessLog (operator name snapshot) lands in the same
 *   transaction, so a ticket can never exist without its timeline root
 */
export async function createTicket(
  { prisma, clock }: TicketServiceDeps,
  creator: AuthenticatedUser,
  input: TicketCreateData,
  options?: { allowDuplicate?: boolean },
) {
  const data = applyNoPolicyNumber(input);
  const role = await prisma.role.findUnique({
    where: { id: creator.roleId },
    select: { requiredTicketFields: true },
  });
  if (role) {
    validateRequiredFields(data, role.requiredTicketFields);
  }

  const now = clock.now();
  const kindId = await requireTicketKindId(prisma, TicketKindKey.Complaint);
  const slaStamp = await computeSlaStamp(prisma, data.slaPolicyId, now, kindId);
  const detail = complaintDetailData(data);

  return prisma.$transaction(async (tx) => {
    // 提交兜底查重：与插入同事务，命中即整体回滚；批量导入不经此路，天然豁免
    if (!options?.allowDuplicate) {
      await assertNoDuplicateTickets(
        { prisma: tx, clock },
        {
          policyNumbers: data.policyNumbers,
          phone: data.phone,
          contactPhone: data.contactPhone,
        },
      );
    }
    // 校验与插入同事务（与编辑路径的时序一致）；并发删除由 FK Restrict 兜底
    await ticketCategoryCatalog.resolveNewRef(tx, data.categoryId);
    await channelCatalog.resolveNewRef(tx, data.channelId);
    await userFeedbackChannelCatalog.resolveNewRef(tx, data.userFeedbackChannelId);
    await feedbackReceiveChannelCatalog.resolveNewRef(tx, data.feedbackReceiveChannelId);

    const ticket = await tx.ticket.create({
      data: {
        contactPhone: data.contactPhone,
        createdAt: now,
        slaAnchorAt: now,
        kindId,
        source: "manual",
        creatorId: creator.id,
        status: TicketStatus.Unassigned,
        ...slaStamp,
        complaintDetail: {
          create: {
            ...detail,
            feedbackTime: toDateOrNull(detail.feedbackTime),
            contactTime: toDateOrNull(detail.contactTime),
          },
        },
      },
    });

    await tx.processLog.create({
      data: {
        ticketId: ticket.id,
        operatorId: creator.id,
        // Name snapshot on purpose: the timeline shows who it was
        // at the time, even after renames — unlike the derived createdBy.
        operatorName: creator.name,
        action: "create",
        remark: "创建工单",
        at: now,
      },
    });

    return ticket;
  });
}

const listInclude = {
  creator: { select: { name: true } },
  // Current follow-up owner is derived via JOIN, never stored
  assignee: { select: { name: true } },
  slaPolicy: { select: { name: true } },
  complaintDetail: {
    select: {
      customerName: true,
      policyNumbers: true,
      noPolicyNumber: true,
      // Catalog references render their CURRENT names — a rename shows through
      category: { select: { name: true } },
      channel: { select: { name: true } },
    },
  },
} satisfies Prisma.TicketInclude;

type TicketListRow = Prisma.TicketGetPayload<{ include: typeof listInclude }>;

type TicketListFilters = Pick<
  TicketListQuery,
  | "status"
  | "kindId"
  | "channelId"
  | "categoryId"
  | "completionStatusId"
  | "slaPolicyId"
  | "assigneeId"
  | "firstResponse"
  | "policyNumberState"
  | "source"
  | "search"
  | "createdFrom"
  | "createdTo"
>;

/**
 * 保单号搜索支的命中 id 预取。搜索契约是子串、不区分大小写，且以各值的
 * 空格连接形态整体匹配（带空格的搜索词可跨值命中）；Prisma 的标量数组
 * 过滤器只有整项精确匹配，表达不了这条谓词，故走 raw SQL。
 */
async function searchPolicyNumbersTicketIds(
  prisma: PrismaClient,
  search: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ ticketId: string }>>`
    SELECT "ticketId" FROM ticket_complaint_details WHERE array_to_string("policyNumbers", ' ') ILIKE ${substringSearchPattern(search)}
  `;
  return rows.map((row) => row.ticketId);
}

/**
 * The ONE WHERE for "what this viewer's filtered list contains" — shared by
 * the paged list and the export so the two can never disagree. Applies:
 *
 * - soft-delete exclusion (deletedAt null)
 * - the RBAC data scope — no `ticket.view_all` → only tickets assigned to or
 *   created by the viewer, so the rest of the unassigned pool never reaches
 *   一线客服
 * - the filters, with computed statuses resolved through the single-truth
 *   predicate module rather than restated here
 */
export async function buildTicketListWhere(
  prisma: PrismaClient,
  viewer: AuthenticatedUser,
  query: TicketListFilters,
  now: Date,
): Promise<Prisma.TicketWhereInput> {
  // Each filter is its own AND element so their inner ORs (base-status
  // predicate, search) can never collide.
  const filters: Prisma.TicketWhereInput[] = [];
  if (query.channelId && query.channelId.length > 0) {
    // 退费行无 detail：渠道/类别筛选对退费恒不命中（故意）
    filters.push({ complaintDetail: { channelId: { in: query.channelId } } });
  }
  if (query.categoryId && query.categoryId.length > 0) {
    filters.push({ complaintDetail: { categoryId: { in: query.categoryId } } });
  }
  if (query.completionStatusId && query.completionStatusId.length > 0) {
    filters.push({ completionStatusId: { in: query.completionStatusId } });
  }
  if (query.policyNumberState?.includes("none")) {
    filters.push({ complaintDetail: { noPolicyNumber: true } });
  }
  if (query.source && query.source.length > 0) {
    filters.push({ source: { in: query.source } });
  }
  for (const condition of ticketListFilterConditions(query)) {
    switch (condition.kind) {
      case "statusIn":
        // 多选状态取并集：单状态谓词恰好互斥划分全量工单，OR 后不重不漏
        filters.push({
          OR: condition.statuses.map((status) => displayStatusTicketWhere(status, now)),
        });
        break;
      case "kindIn":
        filters.push({ kindId: { in: [...condition.kindIds] } });
        break;
      case "assigneeIn":
        filters.push({ assigneeId: { in: [...condition.assigneeIds] } });
        break;
      case "firstResponsePending":
        // 待首响口径（业务 invariant）= 在途已分配（assigned/processing）且零次
        // 联系：与 dashboard 待首响卡、我的待办 awaiting_first_response 同口径；
        // 未分配不算待首响（未分配不进任何人的待办）。
        filters.push({
          status: { in: [TicketStatus.Assigned, TicketStatus.Processing] },
          contactCount: 0,
        });
        break;
      case "slaPolicyIn": {
        const inPolicies = { slaPolicyId: { in: [...condition.policyIds] } };
        filters.push(condition.orNull ? { OR: [inPolicies, { slaPolicyId: null }] } : inPolicies);
        break;
      }
      case "search":
        filters.push({
          OR: [
            { workOrderNumber: { contains: condition.term, mode: "insensitive" } },
            {
              complaintDetail: {
                customerName: { contains: condition.term, mode: "insensitive" },
              },
            },
            { id: { in: await searchPolicyNumbersTicketIds(prisma, condition.term) } },
            {
              complaintDetail: { phone: { contains: condition.term, mode: "insensitive" } },
            },
            { contactPhone: { contains: condition.term, mode: "insensitive" } },
          ],
        });
        break;
      case "createdAtRange":
        filters.push({
          createdAt: {
            ...(condition.gte !== undefined && { gte: condition.gte }),
            ...(condition.lte !== undefined && { lte: condition.lte }),
          },
        });
        break;
    }
  }

  return {
    deletedAt: null,
    ...applyTicketDataScope(viewer),
    AND: filters,
  };
}

export function buildTicketListOrderBy(
  query: Pick<TicketListQuery, "sortBy" | "sortOrder">,
): Prisma.TicketOrderByWithRelationInput[] {
  // dueAt is nullable (特急 has none): those rows sort last either direction —
  // "no deadline" is never "most urgent"
  const orderBy: Prisma.TicketOrderByWithRelationInput =
    query.sortBy === "dueAt"
      ? { dueAt: { sort: query.sortOrder, nulls: "last" } }
      : { createdAt: query.sortOrder };
  // id breaks ordering ties so pagination never skips or repeats a row
  return [orderBy, { id: "desc" }];
}

/**
 * Paged ticket list for 工单管理: the shared WHERE/ORDER above,
 * plus pagination. One `clock.now()` serves the whole request, so the rows a
 * computed-status filter selects and the displayStatus they serialize with can
 * never disagree.
 */
export async function listTickets(
  { prisma, clock }: TicketServiceDeps,
  viewer: AuthenticatedUser,
  query: TicketListQuery,
) {
  const now = clock.now();
  const where = await buildTicketListWhere(prisma, viewer, query, now);

  const [rows, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      include: listInclude,
      orderBy: buildTicketListOrderBy(query),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    items: rows.map((row) => serializeTicketListItem(row, now)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function parseNullable<T>(
  schema: { parse: (value: unknown) => T },
  value: string | null,
): T | null {
  return value === null ? null : schema.parse(value);
}

function serializeTicketListItem(ticket: TicketListRow, now: Date) {
  const source = ticketSourceSchema.parse(ticket.source);
  const status = ticketStatusSchema.parse(ticket.status);
  const detail = ticket.complaintDetail;

  return {
    id: ticket.id,
    workOrderNumber: ticket.workOrderNumber,
    createdAt: ticket.createdAt.toISOString(),
    source,
    channel: detail?.channel?.name ?? null,
    category: detail?.category?.name ?? null,
    slaPolicyId: ticket.slaPolicyId,
    slaPolicyName: ticket.slaPolicy?.name ?? null,
    customerName: detail?.customerName ?? null,
    policyNumbers: detail?.policyNumbers ?? [],
    noPolicyNumber: detail?.noPolicyNumber ?? false,
    status,
    displayStatus: deriveDisplayStatus(status, ticket.dueAt, now),
    createdBy: isCreatorBackedSource(source)
      ? (ticket.creator?.name ?? null)
      : TICKET_SOURCE_LABELS[source],
    assigneeId: ticket.assigneeId,
    assigneeName: ticket.assignee?.name ?? null,
    dueAt: ticket.dueAt?.toISOString() ?? null,
  };
}

const detailInclude = {
  creator: { select: { name: true } },
  assignee: { select: { name: true } },
  slaPolicy: { select: { id: true, name: true, active: true } },
  kind: { select: { key: true } },
  // 完结状态 is display-only on the detail page — the CURRENT name suffices
  completionStatus: { select: { name: true } },
  // 退费行无 detail：详情 DTO 的下沉字段键保留、值恒为 null（web 形状契约）
  complaintDetail: {
    include: {
      // id/active ride along for the edit form: a disabled current value stays
      // selectable (labelled 已停用) while other disabled options never appear
      category: { select: { id: true, name: true, active: true } },
      channel: { select: { id: true, name: true, active: true } },
      userFeedbackChannel: { select: { id: true, name: true, active: true } },
      feedbackReceiveChannel: { select: { id: true, name: true, active: true } },
    },
  },
  refundDetail: true,
  // 详情页只展示最新一次投递（完结一次 = 至多一条业务投递，重投复位同一行）
  callbackDeliveries: { orderBy: [{ createdAt: "desc" as const }], take: 1 },
  processLogs: { orderBy: [{ at: "asc" }, { id: "asc" }] },
} satisfies Prisma.TicketInclude;

type TicketWithDetail = Prisma.TicketGetPayload<{ include: typeof detailInclude }>;

/**
 * Full ticket detail + timeline for the detail page. Applies the RBAC data
 * scope (no `ticket.view_all` → only tickets assigned to or created by the
 * viewer) and excludes soft-deleted rows; returns null when the ticket is
 * invisible to the viewer, which the router surfaces as NOT_FOUND (existence
 * is not leaked).
 */
export async function getTicketDetail(
  { prisma, clock }: TicketServiceDeps,
  viewer: AuthenticatedUser,
  ticketId: string,
) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, deletedAt: null, ...applyTicketDataScope(viewer) },
    include: detailInclude,
  });
  return ticket === null ? null : serializeTicketDetail(ticket, clock.now());
}

/**
 * Wire shape for the web app: dates as ISO-8601 strings (no transformer on the
 * tRPC link), plus the read-time derivations — createdBy and the computed
 * display status.
 */
function serializeTicketDetail(ticket: TicketWithDetail, now: Date) {
  // Re-narrow the String columns through the shared schemas so the wire type
  // carries the enum unions — the web renders without a single cast. Nullable
  // columns (未填写) pass null through untouched.
  const source = ticketSourceSchema.parse(ticket.source);
  const status = ticketStatusSchema.parse(ticket.status);
  const detail = ticket.complaintDetail;
  const priority = parseNullable(prioritySchema, detail?.priority ?? null);

  return {
    id: ticket.id,
    workOrderNumber: ticket.workOrderNumber,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    feedbackTime: detail?.feedbackTime?.toISOString() ?? null,
    source,
    // 由谁创建 is derived at read time, never snapshotted onto the ticket:
    // creator-backed tickets show the creator's *current* name, external ones
    // the source label.
    createdBy: isCreatorBackedSource(source)
      ? (ticket.creator?.name ?? null)
      : TICKET_SOURCE_LABELS[source],
    channel: detail?.channel ?? null,
    project: detail?.project ?? null,
    brokerageEntity: detail?.brokerageEntity ?? null,
    paymentChannel: detail?.paymentChannel ?? null,
    internalOrderNumber: detail?.internalOrderNumber ?? null,
    policyNumbers: detail?.policyNumbers ?? [],
    noPolicyNumber: detail?.noPolicyNumber ?? false,
    userFeedbackChannel: detail?.userFeedbackChannel ?? null,
    feedbackReceiveChannel: detail?.feedbackReceiveChannel ?? null,
    customerName: detail?.customerName ?? null,
    phone: detail?.phone ?? null,
    contactPhone: ticket.contactPhone,
    customerRequest: detail?.customerRequest ?? null,
    submissionText: ticket.submissionText,
    nuclearBodyStatus: parseNullable(nuclearBodyStatusSchema, detail?.nuclearBodyStatus ?? null),
    hasContacted: detail?.hasContacted ?? null,
    contactTime: detail?.contactTime?.toISOString() ?? null,
    contactId: detail?.contactId ?? null,
    category: detail?.category ?? null,
    slaPolicyId: ticket.slaPolicyId,
    slaPolicy: ticket.slaPolicy,
    kindKey: ticket.kind.key,
    refundDetail:
      ticket.refundDetail === null
        ? null
        : {
            sysOrderId: ticket.refundDetail.sysOrderId,
            endorNo: ticket.refundDetail.endorNo,
            workOrderType: ticket.refundDetail.workOrderType,
            expectedAmount: ticket.refundDetail.expectedAmount,
            refundCreateTime: ticket.refundDetail.refundCreateTime.toISOString(),
            refundTrades: z.array(refundTradePushSchema).parse(ticket.refundDetail.refundTrades),
            holderName: ticket.refundDetail.holderName,
            holderPhone: ticket.refundDetail.holderPhone,
            companyName: ticket.refundDetail.companyName,
            productId: ticket.refundDetail.productId,
            productName: ticket.refundDetail.productName,
            policyNo: ticket.refundDetail.policyNo,
            failureReason: ticket.refundDetail.failureReason,
            pushedFields: ticket.refundDetail.pushedFields,
            compensationAmount: ticket.refundDetail.compensationAmount,
          },
    callbackDelivery:
      ticket.callbackDeliveries[0] === undefined
        ? null
        : {
            id: ticket.callbackDeliveries[0].id,
            status: z.enum(CALLBACK_DELIVERY_STATUSES).parse(ticket.callbackDeliveries[0].status),
            attempts: ticket.callbackDeliveries[0].attempts,
            lastError: ticket.callbackDeliveries[0].lastError,
            deliveredAt: ticket.callbackDeliveries[0].deliveredAt?.toISOString() ?? null,
          },
    priority,
    followUpFrequency: ticket.followUpFrequency,
    firstResponseRequirement: ticket.firstResponseRequirement,
    status,
    displayStatus: deriveDisplayStatus(status, ticket.dueAt, now),
    assigneeId: ticket.assigneeId,
    // Current follow-up owner is derived via JOIN, never stored
    assigneeName: ticket.assignee?.name ?? null,
    assignedAt: ticket.assignedAt?.toISOString() ?? null,
    dueAt: ticket.dueAt?.toISOString() ?? null,
    nextContactTime: ticket.nextContactTime?.toISOString() ?? null,
    contactCount: ticket.contactCount,
    completionTime: ticket.completionTime?.toISOString() ?? null,
    completionStatus: ticket.completionStatus?.name ?? null,
    processLogs: ticket.processLogs.map((log) => ({
      id: log.id,
      operatorId: log.operatorId,
      operatorName: log.operatorName,
      operatorAvatar: log.operatorAvatar,
      action: processLogActionSchema.parse(log.action),
      from: log.from,
      to: log.to,
      remark: log.remark,
      at: log.at.toISOString(),
    })),
  };
}
