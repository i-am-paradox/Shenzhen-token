/**
 * Daily Check-in Engine
 *
 * Streak-based reward system:
 * Day 1: 50 pts, Day 2: 75, Day 3: 100, Day 4: 150,
 * Day 5: 200, Day 6: 300, Day 7+: 500
 * Miss a day → streak resets.
 *
 * SECURITY: Uses prisma.$transaction to prevent double-claim
 * from concurrent requests.
 */

import { prisma } from "@shen-zhen/database";

/** Points awarded per streak day */
const STREAK_REWARDS: Record<number, number> = {
  1: 50,
  2: 75,
  3: 100,
  4: 150,
  5: 200,
  6: 300,
  7: 500,
};

/** Get reward for a given streak day (caps at day 7 = 500) */
function getStreakReward(streak: number): number {
  if (streak >= 7) return 500;
  return STREAK_REWARDS[streak] ?? 50;
}

/** Today as a Date object with time set to 00:00:00 UTC */
function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Yesterday as a Date object */
function yesterdayUTC(): Date {
  const d = todayUTC();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export interface CheckinResult {
  success: boolean;
  alreadyCheckedIn?: boolean;
  streak: number;
  pointsAwarded: number;
  nextReward: number;
}

/**
 * Perform daily check-in for a user.
 *
 * SECURITY FIX: Entire flow runs inside prisma.$transaction.
 * The unique constraint on [userId, day] is the final guard,
 * but the transaction prevents the "check-then-create" race
 * where two concurrent requests both see "not checked in"
 * and both try to create.
 */
export async function dailyCheckin(userId: number): Promise<CheckinResult> {
  const today = todayUTC();

  try {
    return await prisma.$transaction(async (tx) => {
      // Check if already checked in today (within transaction)
      const existing = await tx.dailyCheckin.findUnique({
        where: { userId_day: { userId, day: today } },
      });

      if (existing) {
        return {
          success: false,
          alreadyCheckedIn: true,
          streak: existing.streak,
          pointsAwarded: 0,
          nextReward: getStreakReward(existing.streak + 1),
        };
      }

      // Check yesterday's check-in for streak continuity
      const yesterday = yesterdayUTC();
      const yesterdayCheckin = await tx.dailyCheckin.findUnique({
        where: { userId_day: { userId, day: yesterday } },
      });

      const streak = yesterdayCheckin ? yesterdayCheckin.streak + 1 : 1;
      const points = getStreakReward(streak);

      // Create check-in record
      await tx.dailyCheckin.create({
        data: {
          userId,
          day: today,
          streak,
          pointsAwarded: points,
        },
      });

      // Award points via ledger (within transaction)
      const sourceId = `checkin_${userId}_${today.toISOString().slice(0, 10)}`;
      await tx.pointLedger.create({
        data: {
          userId,
          amount: points,
          reason: "daily_checkin",
          sourceType: "mini_app",
          sourceId,
          metadata: { streak },
        },
      });

      // Update cached balance
      await tx.user.update({
        where: { id: userId },
        data: { cachedBalance: { increment: points } },
      });

      return {
        success: true,
        streak,
        pointsAwarded: points,
        nextReward: getStreakReward(streak + 1),
      };
    });
  } catch (error: unknown) {
    // Unique constraint violation = concurrent double-claim attempt
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const existing = await prisma.dailyCheckin.findUnique({
        where: { userId_day: { userId, day: today } },
      });
      return {
        success: false,
        alreadyCheckedIn: true,
        streak: existing?.streak ?? 0,
        pointsAwarded: 0,
        nextReward: getStreakReward((existing?.streak ?? 0) + 1),
      };
    }
    throw error;
  }
}

/**
 * Get check-in status for a user (streak, today's status, history).
 * Read-only — no transaction needed.
 */
export async function getCheckinStatus(userId: number): Promise<{
  currentStreak: number;
  checkedInToday: boolean;
  todayReward: number;
  history: Array<{ day: Date; streak: number; pointsAwarded: number }>;
}> {
  const today = todayUTC();

  const history = await prisma.dailyCheckin.findMany({
    where: { userId },
    orderBy: { day: "desc" },
    take: 30,
    select: { day: true, streak: true, pointsAwarded: true },
  });

  const todayEntry = history.find(
    (h) => h.day.toISOString().slice(0, 10) === today.toISOString().slice(0, 10),
  );

  const checkedInToday = !!todayEntry;

  let currentStreak = 0;
  if (checkedInToday) {
    currentStreak = todayEntry.streak;
  } else {
    const yesterday = yesterdayUTC();
    const yesterdayEntry = history.find(
      (h) => h.day.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10),
    );
    if (yesterdayEntry) {
      currentStreak = yesterdayEntry.streak;
    }
  }

  return {
    currentStreak,
    checkedInToday,
    todayReward: checkedInToday ? 0 : getStreakReward(currentStreak + 1),
    history,
  };
}
