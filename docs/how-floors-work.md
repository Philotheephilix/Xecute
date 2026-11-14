# How Floors Works — Plain English Guide

## What is a Floor?

A **floor** is price protection for crypto. When you buy ETH (or any supported asset), you can add a "floor" that guarantees a minimum sell price. Think of it like insurance — if the price drops, you can sell at the floor price instead of taking a loss.

## The Buy Flow

When you click "Buy $10 ETH with 5% floor, 1 day":

### Step 1: Swap
Your $10 USDC is swapped for ETH on Ref Finance (testnet) or 1Click (mainnet).
- **Mainnet**: $10 gets you ~0.0053 ETH at $1,886/ETH
- **Testnet**: $10 gets you ~0.000000000000275 ETH (the testnet pool has fake liquidity — this is NOT real value)

### Step 2: Floor Quote
The risk service calculates:
- **Floor price** = current price × (1 - floor%) = $1,886 × 0.95 = **$1,791.70/ETH**
- **Fee** = based on duration, volatility, and amount (~$0.05-$2.37 depending on params)
- **Duration** = how long the protection lasts (1-2 days on testnet, up to 180 days on mainnet)

### Step 3: Floor Opens
The ETH tokens + USDC fee are sent to the floors contract. The contract:
- Locks the ETH in escrow
- Reserves USDC from the sleeve (the insurance pool) to back the guarantee
- Creates a Floor record with your floor price, quantity, and expiry

## What the Numbers Mean

| Field | Meaning | Example |
|-------|---------|---------|
| **Qty** | How much ETH you bought | 0.0053 ETH |
| **Floor Price** | Guaranteed minimum per-ETH sell price | $1,791.70 |
| **Position Value** | qty × floor_price (what you're guaranteed) | $9.50 |
| **Fee** | Cost of the protection | $0.50 |
| **Duration** | How long the floor lasts | 1 day |
| **Expires** | When protection ends | Nov 15, 2026 |

### Important: Floor Price is PER UNIT, not total

The UI shows "Floor Price: $1,805.00" — this means each ETH token can be sold at $1,805. Your TOTAL protected value is `qty × floor_price`. With 0.0053 ETH, that's $9.57.

## The Three Actions

### 🟢 Sell to Floor
**When**: Price has dropped below your floor. You want to cash out at the guaranteed price.
**What happens**:
1. You give back your ETH tokens to the contract
2. Contract pays you: `qty × floor_price` in USDC
3. Floor status → **Sold**

**Example**: You have 0.0053 ETH with $1,791 floor. ETH drops to $1,500. You sell to floor and receive $9.50 USDC instead of the $7.95 you'd get on the market. You saved $1.55.

### ⚪ Close
**When**: You want your ETH back. Maybe the price went UP and you want to hold or sell on market.
**What happens**:
1. Contract returns your ETH tokens to you
2. You give up the floor protection
3. Reserved USDC is freed back to the sleeve
4. Floor status → **Closed**

**Example**: ETH goes to $2,200. Your floor at $1,791 is useless. Close the position, get your 0.0053 ETH back, sell on market for $11.66 instead of $9.50.

### ⏰ Expire
**When**: Duration runs out and you didn't sell or close.
**What happens**:
1. After expiry time, anyone can trigger the expire
2. ETH tokens returned to you automatically
3. Reserved USDC freed back to sleeve
4. Floor status → **Expired**

**Note**: If ETH price was below your floor during the protection period and you didn't sell, you lose the protection. The floor is only usable while active.

## Why Testnet Numbers Look Weird

### The Pool Problem
Testnet Ref Finance pool 365 (USDC/ETH) has **zero real liquidity**. The exchange rate is wildly distorted:
- $10 USDC → ~275,000 raw ETH units
- 275,000 raw / 10^18 = 0.000000000000275 ETH
- At real ETH price (~$1,900), this is worth: **$0.000000000000522**

So you pay $10 and get essentially $0 of ETH. The floor price per-unit ($1,805) is real, but your total protected value is $0.0000005.

### Floors #17, #18 (0.01 ETH)
These were opened manually during testing with **minted** ETH (not from swaps). They have 0.01 ETH which is a realistic amount. Their floor value is $18-$30 which makes sense.

### What it would look like on mainnet
| You pay | You get | Floor price | Protected value | Fee |
|---------|---------|------------|-----------------|-----|
| $10 USDC | 0.0053 ETH | $1,791/ETH | $9.50 | $0.50 |
| $100 USDC | 0.053 ETH | $1,791/ETH | $94.92 | $2.37 |
| $1,000 USDC | 0.53 ETH | $1,791/ETH | $949.23 | $15.80 |

## The Sleeve

The "sleeve" is the insurance pool that backs floor guarantees. When a floor opens:
- USDC equal to `qty × floor_price` is **reserved** from the sleeve
- If the user sells to floor, that USDC pays them
- If the user closes or the floor expires, the reserved USDC is **freed** back to the sleeve

The sleeve has a capacity limit — it can only back so many floors at once.

## Summary

1. **Buy**: USDC → swap → ETH + open floor (with fee)
2. **Hold**: Your ETH is protected. If price drops, sell at floor price. If price rises, close and keep gains.
3. **Sell to Floor**: Exercise the guarantee — get USDC at floor price
4. **Close**: Cancel protection — get ETH back
5. **Expire**: Time runs out — ETH returned, protection ends
