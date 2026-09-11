/**
 * Wheel-cycle reconstruction.
 *
 * Pairs option opens with closes FIFO per (account, contract), then derives
 * premium captured, days held, and return on capital committed.
 *
 * Two facts the SDK types do not tell you, both verified against the Rust core:
 *  1. `ActivityDetails` carries `instrumentType` and `assetContractMultiplier`
 *     on the wire even though the published interface omits them, so options
 *     can be identified without an `assets.getProfile` round trip per contract.
 *  2. The canonical subtypes are POSITION_OPEN / POSITION_CLOSE / OPTION_EXPIRY.
 *     The SDK's ACTIVITY_SUBTYPES constants (OPTION_OPEN, OPTION_CLOSE, ...) are
 *     a DIFFERENT vocabulary and match nothing. Never compare against those.
 */

export type Side = 'SHORT' | 'LONG';

/**
 * `ASSIGNED` and `EXPIRED` are the fork the whole wheel turns on: an assigned
 * put leaves you holding shares and the cycle continues, a worthless expiry
 * ends it with the premium kept. The broker feed reports both as the same
 * OPTION_EXPIRY subtype — see `matchAssignments` for how they are told apart.
 */
export type Outcome = 'OPEN' | 'CLOSED' | 'ASSIGNED' | 'EXPIRED';

/** ActivityDetails plus the wire-only fields the SDK interface omits. */
export interface WireActivity {
  id: string;
  accountId: string;
  accountName: string;
  activityType: string;
  subtype?: string | null;
  date: Date | string;
  quantity?: string | number | null;
  amount?: string | number | null;
  unitPrice?: string | number | null;
  assetId?: string | null;
  assetSymbol: string;
  assetName?: string | null;
  currency: string;
  instrumentType?: string | null;
  assetContractMultiplier?: string | number | null;
}

export interface OptionSpec {
  underlying: string;
  expiry: string; // ISO yyyy-mm-dd
  kind: 'PUT' | 'CALL';
  strike: number;
}

export interface Leg extends OptionSpec {
  key: string;
  accountId: string;
  accountName: string;
  symbol: string;
  currency: string;
  side: Side;
  contracts: number;
  multiplier: number;
  opened: string;
  closed: string | null;
  premiumIn: number;
  premiumOut: number;
  outcome: Outcome;
  days: number;
  net: number;
  capital: number;
  roc: number;
  annualized: number;
}

type BareLeg = Omit<Leg, 'days' | 'net' | 'capital' | 'roc' | 'annualized'>;

const OSI = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOsi(symbol: string): OptionSpec | null {
  const m = OSI.exec((symbol || '').replace(/\s+/g, ''));
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m;
  return {
    underlying: root,
    expiry: `20${yy}-${mm}-${dd}`,
    kind: cp === 'P' ? 'PUT' : 'CALL',
    strike: parseInt(strike, 10) / 1000,
  };
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

const iso = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

const daysBetween = (a: string, b: string): number =>
  Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

export function isOption(a: WireActivity): boolean {
  if (a.instrumentType) return a.instrumentType.toUpperCase() === 'OPTION';
  return parseOsi(a.assetSymbol) !== null; // fallback when the field is absent
}

type Intent = 'OPEN' | 'CLOSE' | 'EXPIRE' | null;

/** Canonical subtypes only. Returns null when the activity carries no intent. */
function declaredIntent(a: WireActivity): Intent {
  switch ((a.subtype || '').toUpperCase()) {
    case 'POSITION_OPEN':
      return 'OPEN';
    case 'POSITION_CLOSE':
      return 'CLOSE';
    case 'OPTION_EXPIRY':
      return 'EXPIRE';
    default:
      return null;
  }
}

interface OpenLot {
  act: WireActivity;
  side: Side;
  qty: number;
  premium: number;
}

function enrich(l: BareLeg, today: string): Leg {
  const days = daysBetween(l.opened, l.closed ?? today);
  // A short keeps premium received less what it paid to close. A long is the
  // mirror image, and a long that expires worthless loses the whole premium.
  let net = l.side === 'SHORT' ? l.premiumIn - l.premiumOut : l.premiumOut - l.premiumIn;
  if (l.side === 'LONG' && l.outcome === 'EXPIRED') net = -l.premiumIn;
  // Capital committed: strike notional for a short (a cash-secured put, or the
  // proceeds a covered call gives up); for a long it is the premium paid.
  const capital =
    l.side === 'SHORT' ? l.strike * l.multiplier * l.contracts : Math.max(l.premiumIn, 1e-9);
  const roc = capital ? net / capital : 0;
  return { ...l, days, net, capital, roc, annualized: (roc * 365) / days };
}

/** A share movement in the underlying: the other half of an assignment. */
export interface EquityEvent {
  id: string;
  accountId: string;
  accountName: string;
  assetId: string | null;
  symbol: string;
  currency: string;
  date: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Share movements, which arrive in the same `activities.getAll()` payload the
 * options come from — no extra permission, no extra round trip.
 *
 * Transfers are deliberately excluded: they move existing shares between
 * accounts and never represent an assignment.
 */
export function extractEquityEvents(activities: WireActivity[]): EquityEvent[] {
  return activities
    .filter((a) => !isOption(a))
    .filter((a) => a.activityType === 'BUY' || a.activityType === 'SELL')
    .map((a) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: a.accountName,
      assetId: a.assetId ?? null,
      symbol: a.assetSymbol,
      currency: a.currency,
      date: iso(a.date),
      direction: a.activityType as 'BUY' | 'SELL',
      quantity: Math.abs(num(a.quantity)),
      unitPrice: Math.abs(num(a.unitPrice)),
      amount: Math.abs(num(a.amount)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Symbol -> asset id, for contracts as well as tickers.
 *
 * The host's asset page is routed by asset id, not by symbol, so this is what
 * makes a per-leg "open the chart" link possible. Keyed on the raw
 * `assetSymbol`, which matters because a padded `MU    260529P00955000` and a
 * bare `MU260529P00955000` are two separate assets in the host's own database.
 * A symbol with no asset id has no entry, and the caller should hide the link.
 */
export function assetIdsBySymbol(activities: WireActivity[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of activities) {
    if (!a.assetId) continue;
    if (!out[a.assetSymbol]) out[a.assetSymbol] = a.assetId;
  }
  return out;
}

/**
 * Promote expiries that were really assignments.
 *
 * A short put assigned on 2026-07-31 shows up as an OPTION_EXPIRY on the
 * contract *plus* a stock BUY of 100 shares at the strike, same account, same
 * day. A put that simply expired worthless has no such partner. Calls are the
 * mirror image, paired with a SELL.
 *
 * Share quantity is consumed as it is claimed, so two puts assigned on one day
 * cannot both point at the same BUY. Candidates are tried nearest-strike-first,
 * which keeps the right leg paired with the right fill when several land
 * together. Price is a tie-breaker rather than a requirement — brokers differ
 * on whether the fill is booked at the strike.
 *
 * Longs are left alone: an exercised long is a different economic event, and
 * treating it as an assignment would silently rewrite its P&L.
 */
function matchAssignments(legs: Leg[], equities: EquityEvent[]): void {
  if (!equities.length) return;
  const remaining = new Map<string, number>(equities.map((e) => [e.id, e.quantity]));

  const candidates = legs
    .filter((l) => l.outcome === 'EXPIRED' && l.side === 'SHORT' && l.closed)
    .sort((a, b) => (a.closed ?? '').localeCompare(b.closed ?? '') || a.key.localeCompare(b.key));

  for (const leg of candidates) {
    const want = leg.contracts * leg.multiplier;
    if (want <= 0) continue;
    const direction = leg.kind === 'PUT' ? 'BUY' : 'SELL';

    const fills = equities
      .filter(
        (e) =>
          e.accountId === leg.accountId &&
          e.symbol === leg.underlying &&
          e.date === leg.closed &&
          e.direction === direction &&
          (remaining.get(e.id) ?? 0) > 1e-9,
      )
      .sort((a, b) => Math.abs(a.unitPrice - leg.strike) - Math.abs(b.unitPrice - leg.strike));

    const available = fills.reduce((s, e) => s + (remaining.get(e.id) ?? 0), 0);
    if (available + 1e-9 < want) continue; // no shares moved: it really did expire

    let need = want;
    for (const e of fills) {
      if (need <= 1e-9) break;
      const have = remaining.get(e.id) ?? 0;
      const take = Math.min(have, need);
      remaining.set(e.id, have - take);
      need -= take;
    }
    leg.outcome = 'ASSIGNED';
  }
}

export function buildLegs(activities: WireActivity[], asOf: Date = new Date()): Leg[] {
  const opts = activities
    .filter(isOption)
    .map((a) => ({ a, spec: parseOsi(a.assetSymbol) }))
    .filter((x): x is { a: WireActivity; spec: OptionSpec } => x.spec !== null)
    .sort((x, y) => iso(x.a.date).localeCompare(iso(y.a.date)));

  const open = new Map<string, OpenLot[]>();
  const legs: Leg[] = [];
  const today = iso(asOf);
  const push = (l: BareLeg) => legs.push(enrich(l, today));

  for (const { a, spec } of opts) {
    const key = `${a.accountId}|${a.assetSymbol}`;
    const queue = open.get(key) ?? [];
    const mult = num(a.assetContractMultiplier) || 100;
    const qty = Math.abs(num(a.quantity));
    const amt = Math.abs(num(a.amount));

    let intent = declaredIntent(a);
    if (intent === null) {
      // No subtype: a trade on the opposite side of existing open interest
      // closes it; anything else opens (short on SELL, long on BUY).
      intent = queue.length && a.activityType !== queue[0].act.activityType ? 'CLOSE' : 'OPEN';
    }

    if (intent === 'OPEN') {
      queue.push({
        act: a,
        side: a.activityType === 'SELL' ? 'SHORT' : 'LONG',
        qty,
        premium: amt,
      });
      open.set(key, queue);
      continue;
    }

    let remaining = qty;
    while (remaining > 1e-9 && queue.length) {
      const lot = queue[0];
      const take = Math.min(remaining, lot.qty);
      const frac = take / lot.qty;
      push({
        key: `${a.id}:${lot.act.id}`,
        accountId: a.accountId,
        accountName: a.accountName,
        symbol: a.assetSymbol,
        currency: a.currency,
        ...spec,
        side: lot.side,
        contracts: take,
        multiplier: mult,
        opened: iso(lot.act.date),
        closed: iso(a.date),
        premiumIn: lot.premium * frac,
        premiumOut: qty ? amt * (take / qty) : 0,
        // Provisional: `matchAssignments` promotes shorts to ASSIGNED below.
        outcome: intent === 'EXPIRE' ? 'EXPIRED' : 'CLOSED',
      });
      lot.qty -= take;
      lot.premium *= 1 - frac;
      remaining -= take;
      if (lot.qty <= 1e-9) queue.shift();
    }
    open.set(key, queue);
  }

  for (const [, queue] of open) {
    for (const lot of queue) {
      if (lot.qty <= 1e-9) continue;
      const spec = parseOsi(lot.act.assetSymbol);
      if (!spec) continue;
      push({
        key: `open:${lot.act.id}`,
        accountId: lot.act.accountId,
        accountName: lot.act.accountName,
        symbol: lot.act.assetSymbol,
        currency: lot.act.currency,
        ...spec,
        side: lot.side,
        contracts: lot.qty,
        multiplier: num(lot.act.assetContractMultiplier) || 100,
        opened: iso(lot.act.date),
        closed: null,
        premiumIn: lot.premium,
        premiumOut: 0,
        outcome: 'OPEN',
      });
    }
  }

  matchAssignments(legs, extractEquityEvents(activities));

  return legs.sort(
    (a, b) =>
      a.accountName.localeCompare(b.accountName) ||
      a.underlying.localeCompare(b.underlying) ||
      a.opened.localeCompare(b.opened),
  );
}

export interface Summary {
  legs: number;
  open: number;
  closed: number;
  netPremium: number;
  realized: number;
  unrealized: number;
  capitalAtRisk: number;
  winRate: number;
  avgAnnualized: number;
}

export function summarize(legs: Leg[]): Summary {
  const closed = legs.filter((l) => l.outcome !== 'OPEN');
  const openLegs = legs.filter((l) => l.outcome === 'OPEN');
  const wins = closed.filter((l) => l.net > 0).length;
  // Capital-weighted, so a 2263% one-day leg on $10k cannot dominate the mean.
  const capital = closed.reduce((s, l) => s + l.capital, 0);
  const weighted = capital
    ? closed.reduce((s, l) => s + l.annualized * l.capital, 0) / capital
    : 0;
  return {
    legs: legs.length,
    open: openLegs.length,
    closed: closed.length,
    netPremium: legs.reduce((s, l) => s + l.net, 0),
    realized: closed.reduce((s, l) => s + l.net, 0),
    unrealized: openLegs.reduce((s, l) => s + l.net, 0),
    capitalAtRisk: openLegs.reduce((s, l) => s + l.capital, 0),
    winRate: closed.length ? wins / closed.length : 0,
    avgAnnualized: weighted,
  };
}

export interface Group {
  underlying: string;
  legs: Leg[];
  summary: Summary;
}

export function groupByUnderlying(legs: Leg[]): Group[] {
  const m = new Map<string, Leg[]>();
  for (const l of legs) {
    const bucket = m.get(l.underlying);
    if (bucket) bucket.push(l);
    else m.set(l.underlying, [l]);
  }
  return [...m.entries()]
    .map(([underlying, ls]) => ({ underlying, legs: ls, summary: summarize(ls) }))
    .sort((a, b) => b.summary.netPremium - a.summary.netPremium);
}
