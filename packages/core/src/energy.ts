/**
 * Shén Zhèn Airdrop — Energy System (Tap-to-Earn)
 *
 * Server-authoritative energy system. The client shows a smooth animation,
 * but the SERVER is the source of truth for energy values.
 *
 * SECURITY: All state mutations happen inside prisma.$transaction with
 * raw SELECT ... FOR UPDATE to prevent double-spend race conditions.
 */

import { prisma } from "@shen-zhen/database";
import type { User } from "@shen-zhen/database";
import type { EnergyState, TapResult, SourceType } from "@shen-zhen/shared";
import { MAX_TAP_BATCH_SIZE, TAP_BATCH_COOLDOWN_MS } from "@shen-zhen/shared";

/**
 * Calculate current energy based on stored state + elapsed time.
 * Pure function — no side effects, no DB calls.
 */
export function calculateCurrentEnergy(
  storedEnergy: number,
  maxEnergy: number,
  regenRate: number,
  lastUpdateTime: Date,
): number {
  const now = Date.now();
  const elapsedSeconds = (now - lastUpdateTime.getTime()) / 1000;
  const regenerated = Math.floor(elapsedSeconds * regenRate);
  return Math.min(maxEnergy, storedEnergy + regenerated);
}

/**
 * Get a user's current energy state (with regeneration calculated).
 */
export function getEnergyState(user: User): EnergyState {
  const current = calculateCurrentEnergy(
    user.energy,
    user.maxEnergy,
    user.energyRegenRate,
    user.energyUpdatedAt,
  );

  const deficit = user.maxEnergy - current;
  const secondsToFull =
    deficit <= 0 ? 0 : Math.ceil(deficit / user.energyRegenRate);

  return {
    current,
    max: user.maxEnergy,
    regenRate: user.energyRegenRate,
    secondsToFull,
  };
}

/**
 * Process a batch of taps from the Mini App.
 *
 * SECURITY FIX: Entire flow runs inside a serializable transaction
 * with SELECT ... FOR UPDATE to lock the user row. This prevents:
 * - Two requests reading the same energy → double awarding points
 * - Race between energy check and deduction
 *
 * Rate limiting is now DB-backed via lastTapAt column check.
 */
export async function processTaps(
  userId: number,
  requestedTaps: number,
  sourceType: SourceType,
): Promise<TapResult & { success: boolean; error?: string }> {
  // Validate tap count (stateless check — safe outside transaction)
  if (requestedTaps < 1 || requestedTaps > MAX_TAP_BATCH_SIZE) {
    return {
      success: false,
      error: `Tap count must be between 1 and ${MAX_TAP_BATCH_SIZE}`,
      pointsEarned: 0,
      newBalance: 0,
      energy: { current: 0, max: 0, regenRate: 0, secondsToFull: 0 },
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the user row to prevent concurrent tap processing
      const rows = await tx.$queryRawUnsafe<User[]>(
        `SELECT * FROM "User" WHERE id = $1 FOR UPDATE`,
        userId,
      );
      const user = rows[0];

      if (!user) {
        return {
          success: false,
          error: "User not found",
          pointsEarned: 0,
          newBalance: 0,
          energy: { current: 0, max: 0, regenRate: 0, secondsToFull: 0 },
        };
      }

      if (user.isBanned) {
        return {
          success: false,
          error: "Account is banned",
          pointsEarned: 0,
          newBalance: 0,
          energy: { current: 0, max: 0, regenRate: 0, secondsToFull: 0 },
        };
      }

      // DB-backed rate limiting: check lastTapAt timestamp
      const now = Date.now();
      if (user.lastTapAt && now - user.lastTapAt.getTime() < TAP_BATCH_COOLDOWN_MS) {
        const energyState = getEnergyState(user);
        return {
          success: false,
          error: "Too fast — wait a moment",
          pointsEarned: 0,
          newBalance: 0,
          energy: energyState,
        };
      }

      // Calculate current energy with regeneration
      const currentEnergy = calculateCurrentEnergy(
        user.energy,
        user.maxEnergy,
        user.energyRegenRate,
        user.energyUpdatedAt,
      );

      // Clamp taps to available energy
      const actualTaps = Math.min(requestedTaps, currentEnergy);

      if (actualTaps <= 0) {
        return {
          success: false,
          error: "No energy available",
          pointsEarned: 0,
          newBalance: 0,
          energy: {
            current: currentEnergy,
            max: user.maxEnergy,
            regenRate: user.energyRegenRate,
            secondsToFull: Math.ceil(
              (user.maxEnergy - currentEnergy) / user.energyRegenRate,
            ),
          },
        };
      }

      // Deduct energy + update lastTapAt + update cached balance atomically
      const newEnergy = currentEnergy - actualTaps;
      const totalPoints = actualTaps * user.tapPower;
      const updateTime = new Date();

      await tx.user.update({
        where: { id: userId },
        data: {
          energy: newEnergy,
          energyUpdatedAt: updateTime,
          lastTapAt: updateTime,
          cachedBalance: { increment: totalPoints },
        },
      });

      // Write to ledger within transaction
      const sourceId = `tap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.pointLedger.create({
        data: {
          userId,
          amount: totalPoints,
          reason: "tap",
          sourceType,
          sourceId,
          metadata: { tapCount: actualTaps, tapPower: user.tapPower },
        },
      });

      const newBalance = (user.cachedBalance ?? 0) + totalPoints;
      const deficit = user.maxEnergy - newEnergy;
      const secondsToFull =
        deficit <= 0 ? 0 : Math.ceil(deficit / user.energyRegenRate);

      return {
        success: true,
        pointsEarned: totalPoints,
        newBalance,
        energy: {
          current: newEnergy,
          max: user.maxEnergy,
          regenRate: user.energyRegenRate,
          secondsToFull,
        },
      };
    });
  } catch (error) {
    console.error("[processTaps] Transaction failed:", error);
    return {
      success: false,
      error: "Server error — try again",
      pointsEarned: 0,
      newBalance: 0,
      energy: { current: 0, max: 0, regenRate: 0, secondsToFull: 0 },
    };
  }
}

/**
 * Clean up function — no longer needed since rate limiting is DB-backed.
 * Kept for backward compatibility but now a no-op.
 */
export function cleanupTapRateLimiter(): void {
  // No-op: rate limiting moved to DB (lastTapAt column)
}
