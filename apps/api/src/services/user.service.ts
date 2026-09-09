import type {
  UserAssignRoleData,
  UserCreateData,
  UserSetActiveInput,
  UserUpdateData,
} from "@insuredesk/shared";
import { EXTERNAL_ROLE_PERMISSIONS, isExternalRole } from "@insuredesk/shared";
import { Prisma } from "../generated/prisma/client.ts";
import type { AuthenticatedUser } from "./auth.service.ts";
import { hashPassword } from "./auth.service.ts";
import type { TicketServiceDeps } from "./ticket.service.ts";

/**
 * Accounts are never hard deleted: the `user.delete` point gates
 * 禁用/启用 (the `active` flag), so tickets, process logs, and rosters always
 * keep a live FK target. A disabled account is locked out on BOTH doors:
 * login refuses (PasswordAuthProvider filters on active) and existing
 * sessions die — validateSession re-checks `active` per request, and
 * setUserActive additionally deletes the user's session rows outright.
 */

export class UserNotFoundError extends Error {
  constructor() {
    super("用户不存在");
    this.name = "UserNotFoundError";
  }
}

export class DuplicateUsernameError extends Error {
  constructor() {
    super("用户名已存在");
    this.name = "DuplicateUsernameError";
  }
}

export class DuplicateEmailError extends Error {
  constructor() {
    super("邮箱已被其他用户使用");
    this.name = "DuplicateEmailError";
  }
}

export class RoleOptionNotFoundError extends Error {
  constructor() {
    super("所选角色不存在");
    this.name = "RoleOptionNotFoundError";
  }
}

export class InternalAccountOnlyError extends Error {
  constructor() {
    super("外部账号请在外部账号管理页管理");
    this.name = "InternalAccountOnlyError";
  }
}

export class InternalRoleOnlyError extends Error {
  constructor() {
    super("只能选择内部角色");
    this.name = "InternalRoleOnlyError";
  }
}

export class SelfDisableError extends Error {
  constructor() {
    super("不能禁用自己的账号");
    this.name = "SelfDisableError";
  }
}

export class LastAdminError extends Error {
  constructor() {
    super("系统必须至少保留一名启用的管理员");
    this.name = "LastAdminError";
  }
}

/**
 * Enforce the invariant inside the mutating transaction: count enabled
 * system-role users AFTER the write, throw to roll back when it hit zero.
 * 并发的禁用/改派各写不同的 user 行,行锁互不冲突,READ COMMITTED 下两边的
 * 清点会互相看不见对方未提交的写——先锁系统角色行把清点串行化,后到者
 * 必然看见先到者已提交的结果。
 */
async function assertEnabledAdminRemains(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT id FROM roles WHERE "system" = true FOR UPDATE`;
  const enabledAdmins = await tx.user.count({
    where: { active: true, role: { system: true } },
  });
  if (enabledAdmins === 0) {
    throw new LastAdminError();
  }
}

async function loadRole(prisma: TicketServiceDeps["prisma"], roleId: string) {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    select: { id: true, name: true, permissions: true, system: true },
  });
  if (!role) {
    throw new RoleOptionNotFoundError();
  }
  return role;
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

/**
 * The fence is the role's STORED permission array: 管理员 (system) expands to
 * every positive point yet stays internal.
 */
export async function listUsers({ prisma }: TicketServiceDeps) {
  const rows = await prisma.user.findMany({
    where: {
      NOT: {
        role: { is: { system: false, permissions: { hasSome: [...EXTERNAL_ROLE_PERMISSIONS] } } },
      },
    },
    include: { role: { select: { name: true, system: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    team: row.team,
    active: row.active,
    roleId: row.roleId,
    roleName: row.role.name,
    roleSystem: row.role.system,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function loadInternalRole(prisma: TicketServiceDeps["prisma"], roleId: string) {
  const role = await loadRole(prisma, roleId);
  if (isExternalRole(role)) {
    throw new InternalRoleOnlyError();
  }
  return role;
}

/**
 * Fence a 用户管理 door to 内部账号. Judged on the role's stored permission
 * array — the same predicate the external surface uses, so an account can
 * never be manageable from both sides.
 */
async function assertInternalAccount(prisma: TicketServiceDeps["prisma"], id: string) {
  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: { select: { system: true, permissions: true } } },
  });
  if (!target) {
    throw new UserNotFoundError();
  }
  if (isExternalRole(target.role)) {
    throw new InternalAccountOnlyError();
  }
}

export async function createUser({ prisma }: TicketServiceDeps, input: UserCreateData) {
  await loadInternalRole(prisma, input.roleId);

  const passwordHash = await hashPassword(input.password);
  try {
    const created = await prisma.user.create({
      data: {
        username: input.username,
        name: input.name,
        email: input.email,
        team: input.team,
        roleId: input.roleId,
        passwordHash,
        active: true,
      },
    });
    return { id: created.id, name: created.name };
  } catch (error) {
    throwOnDuplicateIdentity(error);
  }
}

/**
 * Edit basic info (user.edit), username included — sessions key on userId, so
 * a rename leaves the target's live sessions alone; only the next login needs
 * the new handle. Role changes ride assignUserRole. A non-empty password
 * resets the credential, null leaves it untouched. A reset also deletes the
 * target's sessions in the same transaction — whoever held the old credential
 * must not keep riding a live session past the rotation.
 */
export async function updateUser({ prisma }: TicketServiceDeps, input: UserUpdateData) {
  await assertInternalAccount(prisma, input.id);

  const data: Prisma.UserUncheckedUpdateInput = {
    username: input.username,
    name: input.name,
    email: input.email,
    team: input.team,
  };
  if (input.password !== null) {
    data.passwordHash = await hashPassword(input.password);
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
 * 禁用/启用 (the user.delete permission point). Disabling deletes the user's
 * sessions in the same transaction — the "已有会话的下一次请求被拒" guarantee
 * holds even without this (validateSession re-checks `active`), but dead rows
 * shouldn't linger. Self-disable is refused: the operator would saw off the
 * branch they're sitting on. Disabling the last enabled admin is refused —
 * the system's one hard invariant.
 */
export async function setUserActive(
  { prisma }: TicketServiceDeps,
  actor: AuthenticatedUser,
  input: UserSetActiveInput,
) {
  if (input.id === actor.id && !input.active) {
    throw new SelfDisableError();
  }
  await assertInternalAccount(prisma, input.id);

  return prisma.$transaction(async (tx) => {
    let updated: { id: string; name: string; active: boolean; role: { system: boolean } };
    try {
      updated = await tx.user.update({
        where: { id: input.id },
        data: { active: input.active },
        select: { id: true, name: true, active: true, role: { select: { system: true } } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new UserNotFoundError();
      }
      throw error;
    }
    if (!input.active) {
      if (updated.role.system) {
        await assertEnabledAdminRemains(tx);
      }
      await tx.session.deleteMany({ where: { userId: input.id } });
    }
    return { id: updated.id, name: updated.name, active: updated.active };
  });
}

/**
 * 分配角色 (user.assign_role), 内部角色 → 内部角色. Takes effect on the target's
 * very next request: sessions store only the userId — permissions are resolved
 * from the role at validateSession time, never cached. Reassigning the last
 * enabled admin to a non-system role is refused — the system's one hard
 * invariant.
 */
export async function assignUserRole({ prisma }: TicketServiceDeps, input: UserAssignRoleData) {
  const role = await loadInternalRole(prisma, input.roleId);
  await assertInternalAccount(prisma, input.id);

  return prisma.$transaction(async (tx) => {
    let updated: { id: string; name: string };
    try {
      updated = await tx.user.update({
        where: { id: input.id },
        data: { roleId: input.roleId },
        select: { id: true, name: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new UserNotFoundError();
      }
      throw error;
    }
    // 派管理员角色只增不减启用管理员数,无须校验
    if (!role.system) {
      await assertEnabledAdminRemains(tx);
    }
    return { ...updated, roleName: role.name };
  });
}

export async function listRoleOptions({ prisma }: TicketServiceDeps) {
  const roles = await prisma.role.findMany({
    select: { id: true, name: true, system: true, permissions: true },
    orderBy: [{ system: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return roles
    .filter((role) => !isExternalRole(role))
    .map((role) => ({ id: role.id, name: role.name, system: role.system }));
}
