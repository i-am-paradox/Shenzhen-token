/**
 * Earn Page — Premium Tap-to-Earn Experience
 *
 * Features:
 * - Custom SVG coin with glow/pulse animations (no emoji)
 * - Combo counter: rapid taps show multiplier badge
 * - Particle burst effect on tap
 * - Live energy regen with smooth bar animation
 * - Haptic feedback on tap
 * - Debounced server sync (300ms batch)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { UserProfile, EnergyState } from "../api";
import { tap } from "../api";

/* ── Types ──────────────────────────────────────────────── */
interface FloatParticle {
  id: number;
  x: number;
  y: number;
  value: number;
}

interface Props {
  user: UserProfile;
  updateUser: (u: Partial<UserProfile>) => void;
  updateEnergy: (e: EnergyState) => void;
  onNavigate: (page: "home" | "tasks" | "friends" | "leaderboard" | "upgrades" | "games") => void;
}

let particleId = 0;

/* ── SVG Coin Component ─────────────────────────────────── */
function ShenCoin({ size = 140, pressed = false, depleted = false }: { size?: number; pressed?: boolean; depleted?: boolean }) {
  const scale = pressed ? 0.92 : 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{
        transform: `scale(${scale})`,
        transition: "transform 0.1s cubic-bezier(0.34,1.56,0.64,1)",
        filter: depleted ? "grayscale(0.6) brightness(0.5)" : "none",
      }}
    >
      <defs>
        {/* Gold gradient */}
        <radialGradient id="coinGrad" cx="40%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFE066" />
          <stop offset="40%" stopColor="#FFD700" />
          <stop offset="80%" stopColor="#DAA520" />
          <stop offset="100%" stopColor="#B8860B" />
        </radialGradient>
        {/* Glow filter */}
        <filter id="coinGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix in="blur" type="matrix"
            values="0 0 0 0 1  0 0 0 0 0.84  0 0 0 0 0  0 0 0 0.6 0" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Inner shadow */}
        <radialGradient id="coinShine" cx="35%" cy="30%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.4)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>

      {/* Outer glow ring */}
      <circle cx="100" cy="100" r="95" fill="none" stroke="rgba(255,215,0,0.15)" strokeWidth="2" />

      {/* Main coin body */}
      <circle cx="100" cy="100" r="85" fill="url(#coinGrad)" filter="url(#coinGlow)" />

      {/* Coin rim */}
      <circle cx="100" cy="100" r="85" fill="none" stroke="#B8860B" strokeWidth="3" />
      <circle cx="100" cy="100" r="78" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />

      {/* Shine overlay */}
      <circle cx="100" cy="100" r="78" fill="url(#coinShine)" />

      {/* $SHEN text */}
      <text x="100" y="90" textAnchor="middle" fontFamily="Inter, sans-serif"
        fontWeight="900" fontSize="36" fill="#8B6914" letterSpacing="-1">
        $
      </text>
      <text x="100" y="130" textAnchor="middle" fontFamily="Inter, sans-serif"
        fontWeight="900" fontSize="28" fill="#8B6914" letterSpacing="2">
        SHEN
      </text>

      {/* Highlight arc */}
      <path d="M 50 60 Q 75 30 130 45" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────── */
export function HomePage({ user, updateUser, updateEnergy, onNavigate }: Props) {
  const [particles, setParticles] = useState<FloatParticle[]>([]);
  const [localBalance, setLocalBalance] = useState(user.balance);
  const [localEnergy, setLocalEnergy] = useState(user.energy.current);
  const [pressed, setPressed] = useState(false);
  const [combo, setCombo] = useState(0);
  const [showCombo, setShowCombo] = useState(false);
  const tapBuffer = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const comboTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef = useRef(0);

  // Sync from parent
  useEffect(() => { setLocalBalance(user.balance); }, [user.balance]);
  useEffect(() => { setLocalEnergy(user.energy.current); }, [user.energy.current]);

  // ── Live energy regeneration ──────────────────────────
  useEffect(() => {
    if (localEnergy >= user.energy.max) return;
    const interval = setInterval(() => {
      setLocalEnergy((e) => Math.min(e + user.energy.regenRate, user.energy.max));
    }, 1000);
    return () => clearInterval(interval);
  }, [localEnergy >= user.energy.max, user.energy.max, user.energy.regenRate]);

  const energyPct = Math.min(100, Math.round((localEnergy / user.energy.max) * 100));

  // ── Tap Handler ─────────────────────────────────────────
  const handleTap = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (localEnergy <= 0) return;

      // Position for particle
      let x = 0, y = 0;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if ("touches" in e && e.touches[0]) {
        x = e.touches[0].clientX - rect.left;
        y = e.touches[0].clientY - rect.top;
      } else if ("clientX" in e) {
        x = (e as React.MouseEvent).clientX - rect.left;
        y = (e as React.MouseEvent).clientY - rect.top;
      }

      // Haptic
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");

      // Combo system
      tapCountRef.current += 1;
      setCombo(tapCountRef.current);
      setShowCombo(true);
      if (comboTimer.current) clearTimeout(comboTimer.current);
      comboTimer.current = setTimeout(() => {
        tapCountRef.current = 0;
        setCombo(0);
        setShowCombo(false);
      }, 1200);

      // Spawn floating +N
      const pid = particleId++;
      const jitterX = x + (Math.random() - 0.5) * 80;
      setParticles((prev) => [
        ...prev.slice(-12),
        { id: pid, x: jitterX, y: y - 10, value: user.tapPower },
      ]);
      setTimeout(() => setParticles((p) => p.filter((v) => v.id !== pid)), 900);

      // Optimistic updates
      setLocalBalance((b) => b + user.tapPower);
      setLocalEnergy((e) => Math.max(0, e - 1));
      tapBuffer.current += 1;

      // Debounced flush
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(async () => {
        const count = tapBuffer.current;
        tapBuffer.current = 0;
        try {
          const res = await tap(count);
          if (res.success) {
            updateUser({ balance: res.data.balance });
            updateEnergy(res.data.energy);
          }
        } catch {
          /* silent — optimistic UI */
        }
      }, 300);
    },
    [localEnergy, user.tapPower, updateUser, updateEnergy],
  );

  const formattedBalance = localBalance.toLocaleString();

  // Level tier
  const tier = user.tapPower >= 10
    ? { name: "Legend", color: "#FFD700" }
    : user.tapPower >= 5
      ? { name: "Power Tapper", color: "#E17055" }
      : user.tapPower >= 3
        ? { name: "Fast Tapper", color: "#00D4AA" }
        : { name: "Tapper", color: "#8899AA" };

  return (
    <div className="earn-page">
      {/* ── Header ── */}
      <div className="earn-header">
        <div className="earn-level-badge" style={{ borderColor: `${tier.color}44`, color: tier.color }}>
          <span className="earn-level-dot" style={{ background: tier.color }} />
          <span>{tier.name}</span>
        </div>

        <div className="earn-balance-wrap">
          <div className="earn-balance-coin-icon">
            <ShenCoin size={44} />
          </div>
          <span className="earn-balance">{formattedBalance}</span>
        </div>

        <div className="earn-subtitle">Tap the coin to mine $SHEN</div>
      </div>

      {/* ── Coin Tap Area ── */}
      <div className="earn-tap-zone">
        <div className="earn-coin-wrap">
          {/* Animated rings */}
          <div className="earn-ring earn-ring-1" />
          <div className="earn-ring earn-ring-2" />
          <div className="earn-ring earn-ring-3" />

          {/* Combo badge */}
          {showCombo && combo > 2 && (
            <div className="earn-combo-badge" key={combo}>
              <span className="earn-combo-x">×{combo}</span>
              <span className="earn-combo-label">COMBO</span>
            </div>
          )}

          <button
            className={`earn-coin-btn ${pressed ? "pressed" : ""} ${localEnergy <= 0 ? "depleted" : ""}`}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            onTouchStart={(e) => { setPressed(true); handleTap(e); }}
            onTouchEnd={() => setPressed(false)}
            onClick={handleTap}
            disabled={localEnergy <= 0}
          >
            <ShenCoin size={160} pressed={pressed} depleted={localEnergy <= 0} />
            <span className="earn-tap-power-badge">+{user.tapPower}</span>
          </button>

          {/* Floating particles */}
          {particles.map((p) => (
            <div
              key={p.id}
              className="float-point"
              style={{ left: p.x, top: p.y }}
            >
              +{p.value}
            </div>
          ))}
        </div>

        {localEnergy <= 0 && (
          <div className="earn-depleted-msg">
            <span className="earn-depleted-icon">⚡</span>
            <span>Energy depleted — recharging...</span>
          </div>
        )}
      </div>

      {/* ── Energy Bar ── */}
      <div className="earn-energy">
        <div className="earn-energy-header">
          <div className="earn-energy-left">
            <span className="earn-energy-bolt">⚡</span>
            <span className="earn-energy-nums">
              {Math.round(localEnergy)}<span className="earn-energy-max">/{user.energy.max}</span>
            </span>
          </div>
          <div className="earn-energy-regen">
            +{user.energy.regenRate}/s
          </div>
        </div>
        <div className="earn-energy-track">
          <div className="earn-energy-fill" style={{ width: `${energyPct}%` }} />
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div className="earn-stats">
        <div className="earn-stat-card earn-stat-accent">
          <div className="earn-stat-icon">💪</div>
          <div className="earn-stat-num">{user.tapPower}</div>
          <div className="earn-stat-label">Tap Power</div>
        </div>
        <div className="earn-stat-card earn-stat-energy">
          <div className="earn-stat-icon">🔋</div>
          <div className="earn-stat-num">{user.energy.max}</div>
          <div className="earn-stat-label">Max Energy</div>
        </div>
        <div className="earn-stat-card earn-stat-regen">
          <div className="earn-stat-icon">⚡</div>
          <div className="earn-stat-num">{user.energy.regenRate}/s</div>
          <div className="earn-stat-label">Regen Rate</div>
        </div>
      </div>

      {/* ── Quick Actions ── */}
      <div className="earn-quick-actions">
        <button className="earn-quick-btn" onClick={() => onNavigate("games")}>
          <span className="earn-quick-icon">🎰</span>
          <span className="earn-quick-label">Games</span>
        </button>
        <button className="earn-quick-btn" onClick={() => onNavigate("tasks")}>
          <span className="earn-quick-icon">📋</span>
          <span className="earn-quick-label">Tasks</span>
        </button>
        <button className="earn-quick-btn" onClick={() => onNavigate("friends")}>
          <span className="earn-quick-icon">👥</span>
          <span className="earn-quick-label">Friends</span>
        </button>
      </div>

      {/* ── Boost CTA ── */}
      <div className="earn-boost-banner" onClick={() => onNavigate("upgrades")} style={{ cursor: "pointer" }}>
        <div className="earn-boost-left">
          <div className="earn-boost-rocket">🚀</div>
          <div>
            <div className="earn-boost-title">Boost your earnings</div>
            <div className="earn-boost-desc">Upgrade tap power & energy capacity</div>
          </div>
        </div>
        <div className="earn-boost-arrow">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
  );
}
