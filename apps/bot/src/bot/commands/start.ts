/**
 * /start command — Onboarding flow
 *
 * 1. Parse referral code from deep link (if any)
 * 2. Create or find user
 * 3. Check channel membership
 * 4. Trigger CAPTCHA if not verified
 * 5. Show welcome message with Mini App button
 */

import { Context, InlineKeyboard } from "grammy";
import { prisma } from "@shen-zhen/database";
import { createReferral, parseReferralCode, awardPoints } from "@shen-zhen/core";
// import { sendCaptcha } from "../captcha.js"; // CAPTCHA disabled for launch

const REQUIRED_CHANNEL = process.env["REQUIRED_CHANNEL_ID"];


export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const telegramId = BigInt(ctx.from.id);

  // Check if user already exists
  let user = await prisma.user.findUnique({
    where: { telegramId },
  });

  const isNewUser = !user;

  if (!user) {
    // Create new user
    user = await prisma.user.create({
      data: {
        telegramId,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name ?? null,
        isVerified: true,  // Auto-verify on creation (CAPTCHA disabled for now)
      },
    });

    // 🎁 Welcome bonus — 100 points for joining
    await awardPoints(user.id, 100, "welcome_bonus", "bot", `welcome_${user.id}`);

    // Handle referral code from deep link
    const startParam = ctx.match as string | undefined;
    if (startParam) {
      const referrerId = parseReferralCode(startParam);
      if (referrerId && referrerId !== user.id) {
        // Verify referrer exists
        const referrer = await prisma.user.findUnique({
          where: { id: referrerId },
        });

        if (referrer) {
          await createReferral(referrerId, user.id);
          // Also set referredBy on the user
          await prisma.user.update({
            where: { id: user.id },
            data: { referredBy: referrerId },
          });
        }
      }
    }
  }

  // Check channel membership
  if (REQUIRED_CHANNEL) {
    try {
      const member = await ctx.api.getChatMember(
        REQUIRED_CHANNEL,
        ctx.from.id,
      );
      const isMember = ["member", "administrator", "creator"].includes(
        member.status,
      );

      if (!isMember) {
        const channelName = REQUIRED_CHANNEL.startsWith("@")
          ? REQUIRED_CHANNEL
          : "our channel";

        await ctx.reply(
          `👋 Welcome to <b>Shén Zhèn Airdrop</b>!\n\n` +
            `To participate, you need to join ${channelName} first.\n\n` +
            `After joining, tap /start again.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().url(
              "Join Channel",
              `https://t.me/${REQUIRED_CHANNEL.replace("@", "")}`,
            ),
          },
        );
        return;
      }
    } catch {
      // If we can't check (bot not admin in channel), skip the check
      console.warn("Could not check channel membership — is the bot admin?");
    }
  }

  // CAPTCHA disabled for production launch — auto-verify instead
  if (!user.isVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    });
  }

  // User is verified — show welcome message
  await sendWelcome(ctx, isNewUser);
}

export async function sendWelcome(
  ctx: Context,
  isNewUser: boolean,
): Promise<void> {
  // Auto-detect: MINI_APP_URL > Railway public domain > localhost
  const railwayDomain = process.env["RAILWAY_PUBLIC_DOMAIN"];
  const MINI_APP = process.env["MINI_APP_URL"] && !process.env["MINI_APP_URL"].includes("<")
    ? process.env["MINI_APP_URL"]
    : railwayDomain
      ? `https://${railwayDomain}`
      : "http://localhost:5173";

  if (isNewUser) {
    // ─── New User Onboarding ─────────────────────────
    const keyboard = new InlineKeyboard()
      .webApp("🚀 Launch App & Tap to Earn 💎", MINI_APP)
      .row()
      .text("📊 My Balance", "cmd_balance")
      .text("🎯 Earn Tasks", "cmd_tasks")
      .row()
      .text("🤝 Invite Friends", "cmd_invite")
      .text("🏆 Leaderboard", "cmd_leaderboard");

    await ctx.reply(
      `🔥 <b>WELCOME TO SHÉN ZHÈN AIRDROP</b> 🔥\n\n` +
        `Congratulations! You've received a <b>+100 $SHEN Bonus</b> to kickstart your journey! 🎁\n\n` +
        `⚡ <b>Quick Start Guide:</b>\n` +
        `• 👆 <b>Tap to Mine:</b> Earn $SHEN tokens instantly in the Mini App.\n` +
        `• 🎁 <b>Daily Rewards:</b> Log in every 24h for streak multipliers.\n` +
        `• 👥 <b>Refer & Earn:</b> Get 500 points for every active friend invited!\n` +
        `• 🎯 <b>Tasks & Quizzes:</b> Complete simple social tasks for big boosts.\n\n` +
        `👇 <i>Tap the button below to launch your mining hub!</i>`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
  } else {
    // ─── Returning User ──────────────────────────────
    const keyboard = new InlineKeyboard()
      .webApp("🚀 Open Mini App ⚡", MINI_APP)
      .row()
      .text("📊 Balance", "cmd_balance")
      .text("🎯 Tasks", "cmd_tasks")
      .row()
      .text("🤝 Referral Link", "cmd_invite")
      .text("🏆 Leaderboard", "cmd_leaderboard");

    await ctx.reply(
      `⚡ <b>SHÉN ZHÈN AIRDROP HUB</b> ⚡\n\n` +
        `Welcome back, Boss! Your mining rig is waiting for you. 🦾\n\n` +
        `💡 <b>Daily Reminder:</b>\n` +
        `Don't let your energy go to waste. Keep tapping & claim your daily bonus before it resets!\n\n` +
        `👇 <i>Tap below to enter the Mini App!</i>`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
  }
}
