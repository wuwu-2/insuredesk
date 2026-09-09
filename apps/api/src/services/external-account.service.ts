import type {
  ExternalAccountCreateData,
  ExternalAccountListItem,
  ExternalAccountPrefill,
  ExternalAccountSetActiveInput,
  ExternalAccountUpdateData,
} from "@insuredesk/shared";
import { EXTERNAL_ROLE_PERMISSIONS, isExternalRole } from "@insuredesk/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import type { AuthenticatedUser } from "./auth.service.ts";
import { hashPassword } from "./auth.service.ts";
import {
  DuplicateEmailError,
  DuplicateUsernameError,
  SelfDisableError,
  UserNotFoundError,
} from "./user.service.ts";

/**
 * 外部账号管理 domain logic (external_account.manage 单点执法)。外部账号 =
 * users 表普通行 + 唯一外部角色 + 6 预填 + 白名单；内外部之分由角色库存权限
 * 数组判定（isExternalRole），不设独立标记列。
 */

export interface ExternalAccountServiceDeps {
  prisma: PrismaClient;
}

export class ExternalAccountOnlyError extends Error {
  constructor() {
    super("该用户不是外部账号");
    this.name = "ExternalAccountOnlyError";
  }
}

/**
 * 建号要挂的唯一外部角色不存在或不唯一。种子提供恰好一个外部角色,数量对不上
 * 说明库被改坏了 — 明确失败,不猜一个顶上：挂错角色等于给外部账号发错权限。
 */
export class ExternalRoleNotUniqueError extends Error {
  constructor(count: number) {
    super(`外部角色应恰好有 1 个，当前 ${count} 个，无法创建外部账号`);
    this.name = "ExternalRoleNotUniqueError";
  }
}

export class InvalidVisibleFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVisibleFieldError";
  }
}

export class PrefillChannelNotFoundError extends Error {
  constructor() {
    super("所选反馈渠道不存在");
    this.name = "PrefillChannelNotFoundError";
  }
}

export class PrefillUserFeedbackChannelNotFoundError extends Error {
  constructor() {
    super("所选用户反馈渠道不存在");
    this.name = "PrefillUserFeedbackChannelNotFoundError";
  }
}

export class PrefillFeedbackReceiveChannelNotFoundError extends Error {
  constructor() {
    super("所选反馈信息接收渠道不存在");
    this.name = "PrefillFeedbackReceiveChannelNotFoundError";
  }
}

function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  // Driver adapters carry the violated fields at
  // meta.driverAdapterError.cause.constraint.fields instead of meta.target.
  // adapter-pg ≥7.9 prefers the pg-reported constraint name ({ index }), which
  // pg always supplies for 23505, so fields is usually absent; index names
  // follow <table>_<field>_key (see the init migration).
  const constraint = (
    error.meta?.driverAdapterError as
      | { cause?: { constraint?: { fields?: unknown; index?: unknown } } }
      | undefined
  )?.cause?.constraint;
  if (Array.isArray(constraint?.fields)) {
    return constraint.fields.includes(field);
  }
  return typeof constraint?.index === "string" && constraint.index.endsWith(`_${field}_key`);
}

function throwOnDuplicateIdentity(error: unknown): never {
  if (isUniqueViolationOn(error, "username")) {
    throw new DuplicateUsernameError();
  }
  if (isUniqueViolationOn(error, "email")) {
    throw new DuplicateEmailError();
  }
  throw error;
}

/** Judged on the stored permission array, so 管理员 (system) counts as internal. */
async function loadExternalAccount(prisma: PrismaClient, id: string) {
  const target = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: { select: { system: true, permissions: true } },
    },
  });
  if (!target) {
    throw new UserNotFoundError();
  }
  if (!isExternalRole(target.role)) {
    throw new ExternalAccountOnlyError();
  }
  return target;
}

/**
 * The one 外部角色 every 外部账号 is born holding — 建号不选角色, so the role is
 * looked up here rather than passed in.
 */
async function loadSoleExternalRole(prisma: PrismaClient) {
  const roles = await prisma.role.findMany({
    select: { id: true, system: true, permissions: true },
  });
  const external = roles.filter((role) => isExternalRole(role));
  if (external.length !== 1 || !external[0]) {
    throw new ExternalRoleNotUniqueError(external.length);
  }
  return external[0];
}

async function resolvePrefillChannel(prisma: PrismaClient, channelId: string | null) {
  if (channelId === null) {
    return;
  }
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true },
  });
  if (!channel) {
    throw new PrefillChannelNotFoundError();
  }
}

async function resolvePrefillUserFeedbackChannel(prisma: PrismaClient, id: string | null) {
  if (id === null) {
    return;
  }
  const row = await prisma.userFeedbackChannel.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!row) {
    throw new PrefillUserFeedbackChannelNotFoundError();
  }
}

async function resolvePrefillFeedbackReceiveChannel(prisma: PrismaClient, id: string | null) {
  if (id === null) {
    return;
  }
  const row = await prisma.feedbackReceiveChannel.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!row) {
    throw new PrefillFeedbackReceiveChannelNotFoundError();
  }
}

async function resolvePrefillRefs(
  prisma: PrismaClient,
  prefill: Pick<
    ExternalAccountPrefill,
    "channelId" | "userFeedbackChannelId" | "feedbackReceiveChannelId"
  >,
) {
  await resolvePrefillChannel(prisma, prefill.channelId);
  await resolvePrefillUserFeedbackChannel(prisma, prefill.userFeedbackChannelId);
  await resolvePrefillFeedbackReceiveChannel(prisma, prefill.feedbackReceiveChannelId);
}

const EXTERNAL_ACCOUNT_WHERE: Prisma.UserWhereInput = {
  role: { is: { system: false, permissions: { hasSome: [...EXTERNAL_ROLE_PERMISSIONS] } } },
};

const accountListInclude = {
  prefillChannel: { select: { name: true } },
  prefillUserFeedbackChannel: { select: { name: true } },
  prefillFeedbackReceiveChannel: { select: { name: true } },
  _count: { select: { createdTickets: true } },
} as const;

type AccountListRow = Prisma.UserGetPayload<{ include: typeof accountListInclude }>;

function toListItem(row: AccountListRow): ExternalAccountListItem {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    prefill: {
      channelId: row.prefillChannelId,
      channelName: row.prefillChannel?.name ?? null,
      project: row.prefillProject,
      brokerageEntity: row.prefillBrokerageEntity,
      paymentChannel: row.prefillPaymentChannel,
      userFeedbackChannelId: row.prefillUserFeedbackChannelId,
      userFeedbackChannelName: row.prefillUserFeedbackChannel?.name ?? null,
      feedbackReceiveChannelId: row.prefillFeedbackReceiveChannelId,
      feedbackReceiveChannelName: row.prefillFeedbackReceiveChannel?.name ?? null,
    },
    ticketCount: row._count.createdTickets,
  };
}

export async function listExternalAccounts(
  deps: ExternalAccountServiceDeps,
): Promise<ExternalAccountListItem[]> {
  const rows = await deps.prisma.user.findMany({
    where: EXTERNAL_ACCOUNT_WHERE,
    include: accountListInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toListItem);
}

export async function createExternalAccount(
  deps: ExternalAccountServiceDeps,
  input: ExternalAccountCreateData,
) {
  const { prisma } = deps;
  await resolvePrefillRefs(prisma, {
    channelId: input.prefill?.channelId ?? null,
    userFeedbackChannelId: input.prefill?.userFeedbackChannelId ?? null,
    feedbackReceiveChannelId: input.prefill?.feedbackReceiveChannelId ?? null,
  });
  const role = await loadSoleExternalRole(prisma);

  const passwordHash = await hashPassword(input.password);
  try {
    const created = await prisma.user.create({
      data: {
        username: input.username,
        name: input.name,
        email: input.email,
        team: null,
        roleId: role.id,
        passwordHash,
        active: true,
        prefillChannelId: input.prefill?.channelId ?? null,
        prefillProject: input.prefill?.project ?? null,
        prefillBrokerageEntity: input.prefill?.brokerageEntity ?? null,
        prefillPaymentChannel: input.prefill?.paymentChannel ?? null,
        prefillUserFeedbackChannelId: input.prefill?.userFeedbackChannelId ?? null,
        prefillFeedbackReceiveChannelId: input.prefill?.feedbackReceiveChannelId ?? null,
      },
      select: { id: true, name: true },
    });
    return created;
  } catch (error) {
    throwOnDuplicateIdentity(error);
  }
}

export async function updateExternalAccount(
  deps: ExternalAccountServiceDeps,
  input: ExternalAccountUpdateData,
) {
  const { prisma } = deps;
  await loadExternalAccount(prisma, input.id);
  if (input.prefill !== undefined) {
    await resolvePrefillRefs(prisma, input.prefill);
  }

  const data: Prisma.UserUncheckedUpdateInput = {
    username: input.username,
    name: input.name,
    email: input.email,
  };
  if (input.password !== null) {
    data.passwordHash = await hashPassword(input.password);
  }
  if (input.prefill !== undefined) {
    data.prefillChannelId = input.prefill.channelId;
    data.prefillProject = input.prefill.project;
    data.prefillBrokerageEntity = input.prefill.brokerageEntity;
    data.prefillPaymentChannel = input.prefill.paymentChannel;
    data.prefillUserFeedbackChannelId = input.prefill.userFeedbackChannelId;
    data.prefillFeedbackReceiveChannelId = input.prefill.feedbackReceiveChannelId;
  }

  return prisma.$transaction(async (tx) => {
    let updated: { id: string; name: string };
    try {
      updated = await tx.user.update({
        where: { id: input.id },
        data,
        select: { id: true, name: true },
      });
    } catch (error) {
      // P2025 = no user with that id
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new UserNotFoundError();
      }
      throwOnDuplicateIdentity(error);
    }
    if (input.password !== null) {
      await tx.session.deleteMany({ where: { userId: input.id } });
    }
    return updated;
  });
}

/**
 * 禁用/启用 a 外部账号 — same semantics as setUserActive (disable kills live
 * sessions), minus the last-admin check: an 外部账号 is never the system role.
 */
export async function setExternalAccountActive(
  deps: ExternalAccountServiceDeps,
  actor: AuthenticatedUser,
  input: ExternalAccountSetActiveInput,
) {
  const { prisma } = deps;
  if (input.id === actor.id && !input.active) {
    throw new SelfDisableError();
  }
  await loadExternalAccount(prisma, input.id);

  return prisma.$transaction(async (tx) => {
    let updated: { id: string; name: string; active: boolean };
    try {
      updated = await tx.user.update({
        where: { id: input.id },
        data: { active: input.active },
        select: { id: true, name: true, active: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new UserNotFoundError();
      }
      throw error;
    }
    if (!input.active) {
      await tx.session.deleteMany({ where: { userId: input.id } });
    }
    return updated;
  });
}
