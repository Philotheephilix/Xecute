// ---------------------------------------------------------------------------
// In-memory capacity tracking per sleeve / asset
//
// Per asset limits (% of sleeve USDC that can be allocated):
//   ETH  40%  →  4000 bps
//   SOL  35%  →  3500 bps
//   STRK 25%  →  2500 bps
//
// Testnet sleeve holds 100_000 USDC (= 100_000_000_000 in e6).
// A "reservation" is an open quote (unexpired, not yet settled).
// Reservations expire automatically with the quote (TTL 20 s).
// ---------------------------------------------------------------------------

const SLEEVE_USDC_E6 = 100_000n * 1_000_000n; // 100_000 USDC in e6

const MAX_UTILIZATION_BPS: Record<string, number> = {
  ETH: 4000,
  SOL: 3500,
  STRK: 2500,
};

interface Reservation {
  /** quote ID (hex) */
  quoteId: string;
  /** asset */
  asset: string;
  /** floor_price_e6 × qty (notional USDC e6 reserved) */
  notional_e6: bigint;
  /** unix timestamp ms when this reservation expires */
  expiresAt: number;
}

// Active reservations
const reservations = new Map<string, Reservation>();

/** Purge expired reservations (called before every capacity check). */
function purgeExpired(): void {
  const now = Date.now();
  for (const [id, r] of reservations) {
    if (r.expiresAt <= now) {
      reservations.delete(id);
    }
  }
}

/** Compute used notional (e6) for a given asset across all live reservations. */
function usedNotional(asset: string): bigint {
  purgeExpired();
  let total = 0n;
  for (const r of reservations.values()) {
    if (r.asset === asset) {
      total += r.notional_e6;
    }
  }
  return total;
}

/** Maximum notional (e6) allowed for the given asset. */
function maxNotional(asset: string): bigint {
  const bps = MAX_UTILIZATION_BPS[asset] ?? 2500;
  return (SLEEVE_USDC_E6 * BigInt(bps)) / 10_000n;
}

/**
 * Check whether adding `additionalNotional` for `asset` would exceed capacity.
 * Returns true when there IS capacity (quote can proceed).
 */
export function hasCapacity(asset: string, additionalNotional_e6: bigint): boolean {
  const used = usedNotional(asset);
  const limit = maxNotional(asset);
  return used + additionalNotional_e6 <= limit;
}

/**
 * Reserve capacity for an in-flight quote.
 * Call AFTER the capacity check passes (hasCapacity returned true).
 * TTL is 20 s to match the quote lifetime.
 */
export function reserveCapacity(
  quoteId: string,
  asset: string,
  notional_e6: bigint,
  ttlMs = 20_000,
): void {
  purgeExpired();
  reservations.set(quoteId, {
    quoteId,
    asset,
    notional_e6,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Release a reservation immediately (e.g. quote was rejected on-chain, or test cleanup).
 */
export function releaseCapacity(quoteId: string): void {
  reservations.delete(quoteId);
}

/** Exposed for tests / health-check endpoint. */
export function getCapacityInfo(asset: string): {
  used_e6: bigint;
  limit_e6: bigint;
  available_e6: bigint;
} {
  const used = usedNotional(asset);
  const limit = maxNotional(asset);
  return {
    used_e6: used,
    limit_e6: limit,
    available_e6: limit > used ? limit - used : 0n,
  };
}
