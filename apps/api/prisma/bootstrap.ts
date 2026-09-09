import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { bootstrapSystemData } from "./seed-data.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
    options: "-c timezone=UTC",
  }),
});

async function main() {
  console.log("🚀 Bootstrapping system data...");
  const { adminCreated, rolesCreated } = await bootstrapSystemData(prisma, {
    adminUsername: "admin",
    adminPassword: "admin",
  });

  console.log(
    rolesCreated
      ? "✓ Factory roles created (first initialization)"
      : "✓ Roles already initialized — left untouched",
  );
  console.log("✓ Ticket kinds: 2 (inserted if missing)");
  console.log("✓ SLA policies: 4 complaint + 1 refund default (created if missing)");
  console.log("✓ Shift types: 4 (created if missing)");
  console.log("✓ Ticket categories: 17 (first initialization only)");
  console.log("✓ Channels: 4 (first initialization only)");
  console.log(
    adminCreated
      ? '✓ Admin account "admin" created with the default password — change it in 用户管理 immediately'
      : '✓ Admin account "admin" already exists — left untouched',
  );

  // 未设置则 etl_ro 无口令、scram 下无法认证,数据湖直连保持关闭。
  const etlRoPassword = process.env.ETL_RO_PASSWORD;
  if (etlRoPassword) {
    await prisma.$executeRawUnsafe(
      `ALTER ROLE etl_ro PASSWORD '${etlRoPassword.replaceAll("'", "''")}'`,
    );
    console.log("✓ ETL read-only role (etl_ro) password applied from ETL_RO_PASSWORD");
  } else {
    console.log("- ETL_RO_PASSWORD unset — etl_ro has no password, direct DB pull stays closed");
  }

  console.log("\n✅ Bootstrap complete!");
}

main()
  .catch((e) => {
    console.error("❌ Bootstrap failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
