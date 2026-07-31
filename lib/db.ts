import { PrismaClient } from "@prisma/client";

/**
 * A single PrismaClient per process. Next.js dev-server hot reloads re-evaluate
 * modules, which without this would open a new connection pool every edit.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
