/**
 * Spin the Wheel Engine
 *
 * 8-slice wheel with weighted probabilities.
 * 1 free spin every 8 hours, or pay 50 points for extra spin.
 *
 * SECURITY: All mutations wrapped in prisma.$transaction to prevent:
 * - Double free spins from concurrent requests
 * - Paid spin double-spend (balance check + deduct are now atomic)
 */

import { prisma } from "@shen-zhen/database";

/** Wheel slices — index matters for the animation */
export const WHEEL_SLICES = [
  { label: "10",       points: 10,   color: "#2d3436", weight: 30 },
  { label: "25",       points: 25,   color: "#00b894", weight: 25 },
  { label: "50",       points: 50,   color: "#0984e3", weight: 18 },
  { label: "100",      points: 100,  color: "#6c5ce7", weight: 12 },
  { label: "250",      points: 250,  color: "#fdcb6e", weight: 8  },
  { label: "500",      points: 500,  color: "#e17055", weight: 4  },
  { label: "1000",     points: 1000, color: "#d63031", weight: 2  },
  { label: "JACKPOT",  points: 5000, color: "#ffd700", weight: 1  },
] as const;

const FREE_SPIN_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours
const PAID_SPIN_COST = 50;

/** Pick a random slice using weighted probability */
function pickSlice(): number {
  const totalWeight = WHEEL_SLICES.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * totalWeight;

  for (let i = 0; i < WHEEL_SLICES.length; i++) {
    roll -= WHEEL_SLICES[i]!.weight;
    if (roll <= 0) return i;
  }

  return 0; // fallback
}

export interface SpinResult {
  success: boolean;
  error?: string;
  prizeIndex?: number;
  pointsWon?: number;
  label?: string;
  nextFreeSpinAt?: Date;
}

export interface SpinStatus {
  canFreeSpin: boolean;
  nextFreeSpinAt: Date | null;
  totalSpins: number;
  totalWon: number;
  recentSpins: Array<{ pointsWon: number; spinType: string; createdAt: Date }>;
}

/**
 * Get spin status — can they spin? When's next free spin?
 * Read-only — no transaction needed.
 */
export async function getSpinStatus(userId: number): Promise<SpinStatus> {
  const lastFreeSpin = await prisma.spinHistory.findFirst({
    where: { userId, spinType: "free" },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  let canFreeSpin = true;
  let nextFreeSpinAt: Date | null = null;

  if (lastFreeSpin) {
    const cooldownEnd = new Date(lastFreeSpin.createdAt.getTime() + FREE_SPIN_COOLDOWN_MS);
    if (now < cooldownEnd) {
      canFreeSpin = false;
      nextFreeSpinAt = cooldownEnd;
    }
  }

  const [totalSpins, totalWon, recentSpins] = await Promise.all([
    prisma.spinHistory.count({ where: { userId } }),
    prisma.spinHistory.aggregate({
      where: { userId },
      _sum: { pointsWon: true },
    }),
    prisma.spinHistory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { pointsWon: true, spinType: true, createdAt: true },
    }),
  ]);

  return {
    canFreeSpin,
    nextFreeSpinAt,
    totalSpins,
    totalWon: totalWon._sum.pointsWon ?? 0,
    recentSpins,
  };
}

/**
 * Execute a spin — free or paid.
 *
 * SECURITY FIX: Entire operation is wrapped in a transaction.
 * - Free spin: cooldown check + spin creation are atomic
 * - Paid spin: balance check + deduct + spin are atomic
 * This prevents double free spins and paid spin double-spend.
 */
export async function executeSpin(
  userId: number,
  type: "free" | "paid" = "free",
): Promise<SpinResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // ── Free spin: atomic cooldown check ──
      if (type === "free") {
        const lastFreeSpin = await tx.spinHistory.findFirst({
          where: { userId, spinType: "free" },
          orderBy: { createdAt: "desc" },
        });

        if (lastFreeSpin) {
          const cooldownEnd = new Date(lastFreeSpin.createdAt.getTime() + FREE_SPIN_COOLDOWN_MS);
          if (new Date() < cooldownEnd) {
            return {
              success: false,
              error: "Free spin not available yet",
              nextFreeSpinAt: cooldownEnd,
            };
          }
        }
      }

      // ── Paid spin: atomic balance check + deduct ──
      if (type === "paid") {
        const result = await tx.pointLedger.aggregate({
          where: { userId },
          _sum: { amount: true },
        });
        const balance = result._sum.amount ?? 0;

        if (balance < PAID_SPIN_COST) {
          return {
            success: false,
            error: `Need ${PAID_SPIN_COST} points for a paid spin (you have ${balance})`,
          };
        }

        // Deduct cost within the same transaction
        await tx.pointLedger.create({
          data: {
            userId,
            amount: -PAID_SPIN_COST,
            reason: "spin_purchase",
            sourceType: "mini_app",
            sourceId: `paid_spin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          },
        });

        // Update cached balance
        await tx.user.update({
          where: { id: userId },
          data: { cachedBalance: { decrement: PAID_SPIN_COST } },
        });
      }

      // ── Pick the prize ──
      const prizeIndex = pickSlice();
      const prize = WHEEL_SLICES[prizeIndex]!;

      // ── Record spin + award prize atomically ──
      await tx.spinHistory.create({
        data: {
          userId,
          prizeIndex,
          pointsWon: prize.points,
          spinType: type,
        },
      });

      await tx.pointLedger.create({
        data: {
          userId,
          amount: prize.points,
          reason: "spin_reward",
          sourceType: "mini_app",
          sourceId: `spin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          metadata: { prizeIndex, label: prize.label, spinType: type },
        },
      });

      // Update cached balance with prize
      await tx.user.update({
        where: { id: userId },
        data: { cachedBalance: { increment: prize.points } },
      });

      const nextFreeSpinAt = type === "free"
        ? new Date(Date.now() + FREE_SPIN_COOLDOWN_MS)
        : undefined;

      return {
        success: true,
        prizeIndex,
        pointsWon: prize.points,
        label: prize.label,
        nextFreeSpinAt: nextFreeSpinAt ?? undefined,
      };
    });
  } catch (error) {
    console.error("[executeSpin] Transaction failed:", error);
    return {
      success: false,
      error: "Server error — try again",
    };
  }
}
