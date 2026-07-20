/**
 * Shén Zhèn Airdrop — Upgrade System
 *
 * Users spend points to boost their tap power, max energy, or regen rate.
 * Each upgrade has levels with exponentially increasing costs.
 *
 * Cost formula: baseCost * (costMultiplier ^ (currentLevel))
 * (Level 0 = not purchased yet, so first purchase costs baseCost * multiplier^0 = baseCost)
 */

import { prisma } from "@shen-zhen/database";

import type { UpgradeView, UpgradeResult, UpgradeType } from "@shen-zhen/shared";
import { POINT_REASONS, SOURCE_TYPES } from "@shen-zhen/shared";
import { getBalance } from "./points.js";

/**
 * Calculate the cost for the next level of an upgrade.
 */
export function calculateUpgradeCost(
  baseCost: number,
  costMultiplier: number,
  currentLevel: number,
): number {
  return Math.floor(baseCost * Math.pow(costMultiplier, currentLevel));
}

/**
 * Calculate the total effect of an upgrade at a given level.
 */
export function calculateUpgradeEffect(
  baseEffect: number,
  level: number,
): number {
  return baseEffect * level;
}

/**
 * Get all available upgrades with the user's current progress.
 */
export async function getAvailableUpgrades(
  userId: number,
): Promise<UpgradeView[]> {
  // Fetch all active upgrades and user's current levels
  let upgrades = await prisma.upgrade.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  // Auto-seed if empty (e.g. initial production setup)
  if (upgrades.length === 0) {
    await prisma.upgrade.createMany({
      data: [
        {
          slug: "tap_power",
          name: "Tap Power",
          description: "Increase points earned per tap",
          type: "tap_power",
          baseCost: 100,
          costMultiplier: 1.5,
          baseEffect: 1,
          maxLevel: 20,
          iconEmoji: "💪",
          sortOrder: 1,
        },
        {
          slug: "max_energy",
          name: "Energy Capacity",
          description: "Increase maximum energy storage",
          type: "max_energy",
          baseCost: 150,
          costMultiplier: 1.4,
          baseEffect: 200,
          maxLevel: 15,
          iconEmoji: "🔋",
          sortOrder: 2,
        },
        {
          slug: "energy_regen",
          name: "Energy Recharge",
          description: "Faster energy regeneration",
          type: "energy_regen",
          baseCost: 200,
          costMultiplier: 1.6,
          baseEffect: 0.5,
          maxLevel: 10,
          iconEmoji: "⚡",
          sortOrder: 3,
        },
      ],
      skipDuplicates: true,
    });
    upgrades = await prisma.upgrade.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  const [userUpgrades, balance] = await Promise.all([
    prisma.userUpgrade.findMany({
      where: { userId },
    }),
    getBalance(userId),
  ]);

  // Map user's current levels
  const levelMap = new Map<number, number>();
  for (const uu of userUpgrades) {
    levelMap.set(uu.upgradeId, uu.level);
  }

  return upgrades.map((upgrade): UpgradeView => {
    const currentLevel = levelMap.get(upgrade.id) ?? 0;
    const isMaxLevel = currentLevel >= upgrade.maxLevel;
    const nextCost = isMaxLevel
      ? null
      : calculateUpgradeCost(
          upgrade.baseCost,
          upgrade.costMultiplier,
          currentLevel,
        );

    return {
      id: upgrade.id,
      slug: upgrade.slug,
      name: upgrade.name,
      description: upgrade.description,
      type: upgrade.type as UpgradeType,
      currentLevel,
      maxLevel: upgrade.maxLevel,
      nextCost,
      currentEffect: calculateUpgradeEffect(upgrade.baseEffect, currentLevel),
      nextEffect: isMaxLevel
        ? null
        : calculateUpgradeEffect(upgrade.baseEffect, currentLevel + 1),
      iconEmoji: upgrade.iconEmoji,
      canAfford: nextCost !== null && balance >= nextCost,
    };
  });
}

/**
 * Purchase the next level of an upgrade.
 *
 * Flow:
 * 1. Validate upgrade exists and user hasn't maxed it
 * 2. Calculate cost
 * 3. Spend points (atomic balance check + deduction)
 * 4. Increment user's upgrade level
 * 5. Apply the effect to the user's stats
 *
 * All in one transaction.
 */
export async function purchaseUpgrade(
  userId: number,
  upgradeId: number,
): Promise<UpgradeResult> {
  return prisma.$transaction(async (tx) => {
    // Fetch upgrade definition
    const upgrade = await tx.upgrade.findUnique({
      where: { id: upgradeId },
    });

    if (!upgrade || !upgrade.isActive) {
      return {
        success: false,
        newBalance: 0,
        newLevel: 0,
        appliedEffect: "Upgrade not found",
      };
    }

    // Get user's current level for this upgrade
    const userUpgrade = await tx.userUpgrade.findUnique({
      where: {
        userId_upgradeId: { userId, upgradeId },
      },
    });

    const currentLevel = userUpgrade?.level ?? 0;

    if (currentLevel >= upgrade.maxLevel) {
      return {
        success: false,
        newBalance: 0,
        newLevel: currentLevel,
        appliedEffect: "Already at max level",
      };
    }

    // Calculate cost for next level
    const cost = calculateUpgradeCost(
      upgrade.baseCost,
      upgrade.costMultiplier,
      currentLevel,
    );

    // Spend points through the standard engine
    // Note: We're in a transaction, but spendPoints uses its own.
    // To avoid nested transactions, we do the balance check + deduction here directly.
    const balanceResult = await tx.pointLedger.aggregate({
      where: { userId },
      _sum: { amount: true },
    });

    const currentBalance = balanceResult._sum.amount ?? 0;

    if (currentBalance < cost) {
      return {
        success: false,
        newBalance: currentBalance,
        newLevel: currentLevel,
        appliedEffect: "Insufficient balance",
      };
    }

    // Deduct points via ledger entry
    await tx.pointLedger.create({
      data: {
        userId,
        amount: -cost,
        reason: POINT_REASONS.UPGRADE_PURCHASE,
        sourceType: SOURCE_TYPES.MINI_APP,
        sourceId: `upgrade_${upgradeId}_level_${currentLevel + 1}`,
        metadata: {
          upgradeName: upgrade.name,
          upgradeSlug: upgrade.slug,
          fromLevel: currentLevel,
          toLevel: currentLevel + 1,
          cost,
        },
      },
    });

    // Increment upgrade level
    const newLevel = currentLevel + 1;
    await tx.userUpgrade.upsert({
      where: {
        userId_upgradeId: { userId, upgradeId },
      },
      update: { level: newLevel },
      create: { userId, upgradeId, level: newLevel },
    });

    // Apply the effect to the user's stats
    const effectValue = upgrade.baseEffect;
    const updateData: Record<string, number> = {};
    let appliedEffect = "";

    switch (upgrade.type) {
      case "tap_power":
        updateData["tapPower"] = effectValue; // increment
        appliedEffect = `+${effectValue} tap power (now level ${newLevel})`;
        break;
      case "max_energy":
        updateData["maxEnergy"] = effectValue;
        appliedEffect = `+${effectValue} max energy (now level ${newLevel})`;
        break;
      case "energy_regen":
        // energyRegenRate is a float, so we handle it differently
        await tx.user.update({
          where: { id: userId },
          data: {
            energyRegenRate: { increment: effectValue },
          },
        });
        appliedEffect = `+${effectValue} energy/sec (now level ${newLevel})`;
        break;
    }

    // Apply non-float increments
    if (upgrade.type !== "energy_regen" && Object.keys(updateData).length > 0) {
      const incrementData: Record<string, { increment: number }> = {};
      for (const [key, val] of Object.entries(updateData)) {
        incrementData[key] = { increment: val };
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          ...incrementData as Record<string, { increment: number }>,
          cachedBalance: { decrement: cost },
        },
      });
    } else {
      // energy_regen case — still need to update cachedBalance
      await tx.user.update({
        where: { id: userId },
        data: { cachedBalance: { decrement: cost } },
      });
    }

    const newBalance = currentBalance - cost;

    return {
      success: true,
      newBalance,
      newLevel,
      appliedEffect,
    };
  });
}
