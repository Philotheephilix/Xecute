// ---------------------------------------------------------------------------
// Fee preview maths — display only, not authoritative
//
// All bigint values are in USDC base units (6 decimals) unless noted.
// Token amounts are in the token's own smallest unit.
// ---------------------------------------------------------------------------

export interface FeePreview {
  /** USDC reserved = ceil(qty_in_whole_tokens * floor_price_e6) */
  floor_usdc: bigint;
  /** Total fee charged in USDC */
  fee_usdc: bigint;
  /** Platform portion of fee_usdc */
  platform_fee_usdc: bigint;
  /** Backer portion of fee_usdc */
  backer_fee_usdc: bigint;
}

export interface FeePreviewParams {
  /** Token amount in smallest unit */
  qty: bigint;
  /** Decimal precision of the token */
  token_decimals: number;
  /** USDC per whole token × 1e6 (i.e. 6-decimal fixed-point price) */
  floor_price_e6: bigint;
  /** Floor level in basis points (1 bps = 0.01%) */
  floor_bps: number;
  /** Duration in seconds */
  duration_secs: number;
  /** Platform fee in basis points */
  platform_fee_bps: number;
}

/**
 * Preview fee for a floor position.
 *
 * floor_usdc = ceil(qty_whole_tokens * floor_price_e6 / 1e6)
 *            = ceil(qty * floor_price_e6 / 10^(token_decimals + 6))
 *
 * fee_usdc = ceil(floor_usdc * floor_bps / 10000)
 *          × some duration factor (v1: flat, no time scaling)
 *
 * platform_fee_usdc = ceil(fee_usdc * platform_fee_bps / 10000)
 * backer_fee_usdc   = fee_usdc - platform_fee_usdc
 */
export function previewFee(params: FeePreviewParams): FeePreview {
  const {
    qty,
    token_decimals,
    floor_price_e6,
    floor_bps,
    platform_fee_bps,
  } = params;

  // floor_usdc = ceil(qty * floor_price_e6 / 10^token_decimals)
  // floor_price_e6 is USDC-with-6-decimals per whole token
  // qty / 10^token_decimals = whole token count
  // whole_tokens * floor_price_e6 = USDC in 6-decimal representation
  const divisor = BigInt(10) ** BigInt(token_decimals);
  const numerator = qty * floor_price_e6;
  const floor_usdc = ceilDiv(numerator, divisor);

  // fee_usdc = ceil(floor_usdc * floor_bps / 10000)
  const fee_usdc = ceilDiv(floor_usdc * BigInt(floor_bps), 10000n);

  // platform_fee_usdc = ceil(fee_usdc * platform_fee_bps / 10000)
  const platform_fee_usdc = ceilDiv(fee_usdc * BigInt(platform_fee_bps), 10000n);

  // backer gets the remainder
  const backer_fee_usdc = fee_usdc - platform_fee_usdc;

  return { floor_usdc, fee_usdc, platform_fee_usdc, backer_fee_usdc };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ceiling division for non-negative bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('Division by zero');
  if (a === 0n) return 0n;
  return (a + b - 1n) / b;
}
