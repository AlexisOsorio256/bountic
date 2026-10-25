import "server-only";

const SPLITS_REGEX = /<!--\s*bountic-splits:\s*([0-9a-fA-Fx,\s=.:-]+?)\s*-->/i;
const ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

export type WalletShare = {
  address: string;
  /** Basis points of the bounty this address receives. Sums to 10000 across the split. */
  basisPoints: number;
};

function normaliseAddress(value: string): string | null {
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;
}

/**
 * Parse a split declaration out of a PR description.
 *
 * Supported shapes (first match wins):
 *   <!-- bountic-splits: 0xAAA=6000,0xBBB=4000 -->   basis points
 *   <!-- bountic-splits: 0xAAA=60%,0xBBB=40% -->     percentages
 *   <!-- bountic-splits: 0xAAA,0xBBB -->             equal split
 *
 * Returns null when the tag is absent or malformed, so callers keep the
 * single-wallet behaviour untouched.
 */
export function parseWalletSplits(prDescription: string | null): WalletShare[] | null {
  if (!prDescription) return null;

  const tag = SPLITS_REGEX.exec(prDescription);
  if (!tag) return null;

  const entries = tag[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length < 2) return null;

  const parsed: { address: string; weight: number | null }[] = [];
  for (const entry of entries) {
    const [rawAddress, rawWeight] = entry.split("=").map((part) => part?.trim());
    const address = normaliseAddress(rawAddress ?? "");
    if (!address) return null;

    let weight: number | null = null;
    if (rawWeight) {
      const cleaned = rawWeight.replace("%", "");
      const value = Number(cleaned);
      if (!Number.isFinite(value) || value <= 0) return null;
      weight = value;
    }
    parsed.push({ address, weight });
  }

  const addresses = new Set(parsed.map((item) => item.address.toLowerCase()));
  if (addresses.size !== parsed.length) return null;

  const weighted = parsed.filter((item) => item.weight !== null);
  if (weighted.length > 0 && weighted.length !== parsed.length) return null;

  if (weighted.length === 0) {
    const base = Math.floor(10000 / parsed.length);
    const remainder = 10000 - base * parsed.length;
    return parsed.map((item, index) => ({
      address: item.address,
      basisPoints: base + (index === 0 ? remainder : 0),
    }));
  }

  const total = parsed.reduce((sum, item) => sum + (item.weight as number), 0);
  if (total <= 0) return null;

  const shares = parsed.map((item) => ({
    address: item.address,
    basisPoints: Math.round(((item.weight as number) / total) * 10000),
  }));

  const drift = 10000 - shares.reduce((sum, share) => sum + share.basisPoints, 0);
  if (drift !== 0) {
    shares[0].basisPoints += drift;
  }

  return shares;
}

/** Any wallet addresses declared in the description, split tag or not. */
export function declaredWalletAddresses(prDescription: string | null): string[] {
  if (!prDescription) return [];
  return Array.from(new Set(prDescription.match(ADDRESS_REGEX) ?? []));
}

/**
 * Split an amount (in whole USDC units, two decimals) across the shares without
 * losing or inventing a cent: the last recipient absorbs the rounding remainder.
 */
export function splitAmount(amount: number, shares: WalletShare[]): { address: string; amount: number }[] {
  const totalCents = Math.round(amount * 100);
  let allocated = 0;

  return shares.map((share, index) => {
    const isLast = index === shares.length - 1;
    const cents = isLast
      ? totalCents - allocated
      : Math.floor((totalCents * share.basisPoints) / 10000);
    allocated += cents;
    return { address: share.address, amount: cents / 100 };
  });
}
