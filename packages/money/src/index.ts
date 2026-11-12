export type RoundingMode = 'floor' | 'ceil' | 'trunc';

// ---------------------------------------------------------------------------
// Protocol rounding helpers — 100% coverage required
// ---------------------------------------------------------------------------

/**
 * Round raw bigint DOWN (floor) when dropping trailing decimal digits.
 * Used when the protocol pays out: always favour the payer by rounding down.
 *
 * @param raw          - value in base units at `decimals` precision
 * @param decimals     - current decimal precision of `raw`
 * @param displayDecimals - target decimal precision (must be <= decimals)
 */
export function roundDown(
  raw: bigint,
  decimals: number,
  displayDecimals: number,
): bigint {
  if (displayDecimals >= decimals) return raw;
  const shift = BigInt(10) ** BigInt(decimals - displayDecimals);
  // Positive: floor = trunc. Negative: trunc > floor, so subtract 1 if remainder != 0.
  const q = raw / shift;
  const r = raw % shift;
  if (r < 0n) return q - 1n;
  return q;
}

/**
 * Round raw bigint UP (ceil) when dropping trailing decimal digits.
 * Used when the protocol charges or reserves: always charge at least the full amount.
 *
 * @param raw          - value in base units at `decimals` precision
 * @param decimals     - current decimal precision of `raw`
 * @param displayDecimals - target decimal precision (must be <= decimals)
 */
export function roundUp(
  raw: bigint,
  decimals: number,
  displayDecimals: number,
): bigint {
  if (displayDecimals >= decimals) return raw;
  const shift = BigInt(10) ** BigInt(decimals - displayDecimals);
  const q = raw / shift;
  const r = raw % shift;
  if (r > 0n) return q + 1n;
  return q;
}

// ---------------------------------------------------------------------------
// Internal scale helper
// ---------------------------------------------------------------------------
function scaleRaw(
  raw: bigint,
  fromDecimals: number,
  toDecimals: number,
  mode: RoundingMode,
): bigint {
  if (fromDecimals === toDecimals) return raw;
  if (toDecimals > fromDecimals) {
    return raw * (BigInt(10) ** BigInt(toDecimals - fromDecimals));
  }
  // Downscale — apply rounding
  const shift = BigInt(10) ** BigInt(fromDecimals - toDecimals);
  const q = raw / shift;
  const r = raw % shift;
  switch (mode) {
    case 'floor':
      if (r < 0n) return q - 1n;
      return q;
    case 'ceil':
      if (r > 0n) return q + 1n;
      return q;
    case 'trunc':
      return q;
  }
}

// ---------------------------------------------------------------------------
// Amount class
// ---------------------------------------------------------------------------
export class Amount {
  readonly raw: bigint;
  readonly decimals: number;

  constructor(raw: bigint, decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
    }
    this.raw = raw;
    this.decimals = decimals;
  }

  /**
   * Parse a decimal string into an Amount.
   * e.g. parse("1.5", 6) → Amount{ raw: 1_500_000n, decimals: 6 }
   */
  static parse(value: string, decimals: number): Amount {
    if (typeof value !== 'string') throw new TypeError('value must be a string');
    const trimmed = value.trim();
    const negative = trimmed.startsWith('-');
    const abs = negative ? trimmed.slice(1) : trimmed;
    const parts = abs.split('.');
    if (parts.length > 2) throw new SyntaxError(`Invalid decimal string: "${value}"`);
    const intPart = parts[0] ?? /* c8 ignore next */ '';
    const fracPart = parts[1] ?? '';
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
      throw new SyntaxError(`Invalid decimal string: "${value}"`);
    }
    // Pad or truncate fractional part to exactly `decimals` digits
    const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
    const combined = (intPart || '0') + padded;
    const raw = BigInt(combined);
    return new Amount(negative ? -raw : raw, decimals);
  }

  /**
   * Format to a fixed-decimal string.
   * e.g. Amount{ raw: 1_500_000n, decimals: 6 }.format() → "1.500000"
   */
  format(displayDecimals?: number): string {
    const dd = displayDecimals ?? this.decimals;
    if (!Number.isInteger(dd) || dd < 0) {
      throw new RangeError('displayDecimals must be non-negative integer');
    }
    const scaled = scaleRaw(this.raw, this.decimals, dd, 'trunc');
    const negative = scaled < 0n;
    const abs = negative ? -scaled : scaled;
    const base = abs.toString().padStart(dd + 1, '0');
    if (dd === 0) return (negative ? '-' : '') + base;
    const intStr = base.slice(0, base.length - dd);
    const fracStr = base.slice(base.length - dd);
    const result = `${intStr}.${fracStr}`;
    return negative ? `-${result}` : result;
  }

  /**
   * Format as USD string: "$1,234.56"
   * Assumes 2 decimal places for display, input decimals ignored for USD cents logic.
   */
  formatUsd(): string {
    // Scale to 2 decimal places (cents), rounding half-toward-zero (trunc)
    const cents = scaleRaw(this.raw, this.decimals, 2, 'trunc');
    const negative = cents < 0n;
    const absCents = negative ? -cents : cents;
    const dollarStr = (absCents / 100n).toString();
    const centStr = (absCents % 100n).toString().padStart(2, '0');
    // Add commas every 3 digits
    const withCommas = dollarStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}$${withCommas}.${centStr}`;
  }

  add(other: Amount): Amount {
    if (other.decimals !== this.decimals) {
      throw new Error(
        `Cannot add Amounts with different decimals: ${this.decimals} vs ${other.decimals}`,
      );
    }
    return new Amount(this.raw + other.raw, this.decimals);
  }

  sub(other: Amount): Amount {
    if (other.decimals !== this.decimals) {
      throw new Error(
        `Cannot subtract Amounts with different decimals: ${this.decimals} vs ${other.decimals}`,
      );
    }
    return new Amount(this.raw - other.raw, this.decimals);
  }

  mul(factor: bigint): Amount {
    return new Amount(this.raw * factor, this.decimals);
  }

  /**
   * Scale to a different decimal precision with explicit rounding mode.
   */
  scale(newDecimals: number, mode: RoundingMode): Amount {
    return new Amount(scaleRaw(this.raw, this.decimals, newDecimals, mode), newDecimals);
  }

  /**
   * Round to displayDecimals with explicit mode, returning same-decimals Amount.
   */
  round(displayDecimals: number, mode: RoundingMode): Amount {
    const rounded = scaleRaw(this.raw, this.decimals, displayDecimals, mode);
    // Re-scale back up to original decimals
    const restored = scaleRaw(rounded, displayDecimals, this.decimals, mode);
    return new Amount(restored, this.decimals);
  }

  eq(other: Amount): boolean {
    this._assertSameDecimals(other);
    return this.raw === other.raw;
  }

  lt(other: Amount): boolean {
    this._assertSameDecimals(other);
    return this.raw < other.raw;
  }

  lte(other: Amount): boolean {
    this._assertSameDecimals(other);
    return this.raw <= other.raw;
  }

  gt(other: Amount): boolean {
    this._assertSameDecimals(other);
    return this.raw > other.raw;
  }

  gte(other: Amount): boolean {
    this._assertSameDecimals(other);
    return this.raw >= other.raw;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  toString(): string {
    return this.format();
  }

  toJSON(): string {
    return this.format();
  }

  private _assertSameDecimals(other: Amount): void {
    if (other.decimals !== this.decimals) {
      throw new Error(
        `Cannot compare Amounts with different decimals: ${this.decimals} vs ${other.decimals}`,
      );
    }
  }
}
