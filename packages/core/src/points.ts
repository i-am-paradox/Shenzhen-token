/**
 * Shén Zhèn Airdrop — Points Engine
 *
 * THE single award path. Every point ever awarded or spent goes through here.
 * Both bot and Mini App call these functions — never bypass them.
 *
 * Architecture:
 * - Append-only ledger: every award is an INSERT, never an UPDATE
 * - Uniqueness constraint: [userId, reason, sourceId] prevents double-crediting
 * - Balance is cached in User.cachedBalance (updated atomically with ledger)
 * - Negative amounts are used for spending (upgrade purchases)
 */

import { prisma, Prisma } from "@shen-zhen/database";
import type { PointLedger } from "@shen-zhen/database";
import type { PointReason, SourceType } from "@shen-zhen/shared";

export interface AwardResult {
  success: boolean;
  newBalance: number;
  ledgerEntryId?: number;
  error?: string;
}

export interface SpendResult {
  success: boolean;
  newBalance: number;
  error?: string;
}

/**
 * Award points to a user. Writes to append-only ledger + updates cached balance.
 *
 * Uses prisma.$transaction to atomically:
 * 1. Insert ledger entry
 * 2. Increment User.cachedBalance
 *
 * The unique constraint [userId, reason, sourceId] prevents double-crediting.
 */
export async function awardPoints(
  userId: number,
  amount: number,
  reason: PointReason,
  sourceType: SourceType,
  sourceId: string,
  metadata?: Record<string, unknown>,
): Promise<AwardResult> {
  if (amount <= 0) {
    return { success: false, newBalance: 0, error: "Amount must be positive" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Insert ledger entry (unique constraint handles double-credit)
      const entry = await tx.pointLedger.create({
        data: {
          userId,
          amount,
          reason,
          sourceType,
          sourceId,
          metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });

      // Atomically update cached balance
      const user = await tx.user.update({
        where: { id: userId },
        data: { cachedBalance: { increment: amount } },
        select: { cachedBalance: true },
      });

      return {
        success: true as const,
        newBalance: user.cachedBalance,
        ledgerEntryId: entry.id,
      };
    });

    return result;
  } catch (error: unknown) {
    // Check for unique constraint violation (duplicate award)
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const balance = await getBalance(userId);
      return {
        success: false,
        newBalance: balance,
        error: "duplicate",
      };
    }
    throw error;
  }
}

/**
 * Spend points (deduct from balance). Used for upgrade purchases.
 * Creates a negative ledger entry + decrements cached balance.
 *
 * Uses a transaction to ensure atomicity of check-then-deduct.
 * Reads cachedBalance within the transaction for consistency.
 */
export async function spendPoints(
  userId: number,
  amount: number,
  reason: PointReason,
  sourceType: SourceType,
  sourceId: string,
  metadata?: Record<string, unknown>,
): Promise<SpendResult> {
  if (amount <= 0) {
    return { success: false, newBalance: 0, error: "Amount must be positive" };
  }

  return prisma.$transaction(async (tx) => {
    // Read cached balance within transaction
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { cachedBalance: true },
    });

    if (!user) {
      return { success: false, newBalance: 0, error: "User not found" };
    }

    if (user.cachedBalance < amount) {
      return {
        success: false,
        newBalance: user.cachedBalance,
        error: "Insufficient balance",
      };
    }

    // Create negative ledger entry
    await tx.pointLedger.create({
      data: {
        userId,
        amount: -amount,
        reason,
        sourceType,
        sourceId,
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    // Atomically decrement cached balance
    const updated = await tx.user.update({
      where: { id: userId },
      data: { cachedBalance: { decrement: amount } },
      select: { cachedBalance: true },
    });

    return { success: true, newBalance: updated.cachedBalance };
  });
}

/**
 * Get a user's current point balance.
 * Now reads from cached balance (O(1)) instead of SUM(ledger) (O(n)).
 * Falls back to SUM if user not found (shouldn't happen).
 */
export async function getBalance(userId: number): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { cachedBalance: true },
  });

  if (user) return user.cachedBalance;

  // Fallback: compute from ledger
  const result = await prisma.pointLedger.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/**
 * Get a user's point ledger history (audit trail).
 */
export async function getLedgerHistory(
  userId: number,
  limit: number = 20,
  offset: number = 0,
): Promise<{ entries: PointLedger[]; total: number }> {
  const [entries, total] = await Promise.all([
    prisma.pointLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.pointLedger.count({ where: { userId } }),
  ]);

  return { entries, total };
}

/**
 * Award tap points in bulk. Used by the tap-to-earn system.
 * NOTE: processTaps in energy.ts now handles its own transaction,
 * so this function is only used for non-tap awards that need
 * the standard award path.
 */
export async function awardTapPoints(
  userId: number,
  tapCount: number,
  tapPower: number,
  sourceType: SourceType,
): Promise<AwardResult> {
  const totalPoints = tapCount * tapPower;
  const sourceId = `tap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return awardPoints(userId, totalPoints, "tap", sourceType, sourceId, {
    tapCount,
    tapPower,
  });
}
