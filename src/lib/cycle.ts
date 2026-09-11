/**
 * Wheel cycles.
 *
 * `wheel.ts` pairs each contract with its own close and stops there — legs are
 * independent, matched FIFO per (account, contract). That is the right model
 * for "what did this leg earn", and the wrong one for "where am I in the
 * wheel", which is a relationship *between* legs: a cash-secured put gets
 * assigned, the shares it delivers back a covered call, and the call being
 * assigned hands the shares away and starts the loop again.
 *
 * This module reconstructs that loop. It is pure — no host imports — so it
 * tests standalone, the same property that makes the leg engine testable.
 */

import {
  type EquityEvent,
  type Leg,
  type WireActivity,
  extractEquityEvents,
  isOption,
} from './wheel';

export type Stage =
  | 'CSP_OPEN' // short put outstanding, no shares yet
  | 'ASSIGNED_HOLDING' // shares delivered by assignment, no call written
  | 'CC_OPEN' // short call outstanding
  | 'CALLED_AWAY' // shares sold at the call strike — loop complete
  | 'PREMIUM_KEPT' // closed or expired worthless without ever taking shares
  | 'LONG_OPEN'; // a bought option, not a wheel stage but still a live position

export interface Cycle {
  key: string;
  accountId: string;
  accountName: string;
  underlying: string;
  currency: string;
  stage: Stage;
  /** True while the cycle still holds shares or has a leg outstanding. */
  live: boolean;
  legs: Leg[];
  /** Shares this cycle currently holds, delivered by its own assignments. */
  shares: number;
  /** Cost basis of those shares, struck at the assigned put's strike. */
  shareCostBasis: number;
  /** A short call written against fewer shares than it obligates. */
  uncovered: boolean;
  opened: string;
  closed: string | null;
  days: number;
  /** Sum of leg net premium. */
  premium: number;
  /** Realized share P&L: proceeds at the call strike less assigned basis. */
  stockPnl: number;
  total: number;
  capital: number;
  roc: number;
  annualized: number;
}

const EPS = 1e-9;

const iso = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

const daysBetween = (a: string, b: string): number =>
  Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

export function stageLabel(stage: Stage): string {
  switch (stage) {
    case 'CSP_OPEN':
      return 'Cash-secured put';
    case 'ASSIGNED_HOLDING':
      return 'Holding shares';
    case 'CC_OPEN':
      return 'Covered call';
    case 'CALLED_AWAY':
      return 'Called away';
    case 'PREMIUM_KEPT':
      return 'Premium kept';
    case 'LONG_OPEN':
      return 'Long option';
  }
}

/**
 * Share balance over time per (account, ticker), used only to decide whether a
 * written call is actually covered.
 *
 * Deliberately wider than `extractEquityEvents`: shares transferred in from
 * another broker cover a call just as well as shares that were bought, so
 * transfers count here even though they can never *be* an assignment.
 */
function shareTimeline(activities: WireActivity[]): Map<string, { date: string; delta: number }[]> {
  const out = new Map<string, { date: string; delta: number }[]>();
  for (const a of activities) {
    if (isOption(a)) continue;
    const qty = Math.abs(num(a.quantity));
    if (qty <= EPS) continue;
    let delta = 0;
    if (a.activityType === 'BUY' || a.activityType === 'TRANSFER_IN') delta = qty;
    else if (a.activityType === 'SELL' || a.activityType === 'TRANSFER_OUT') delta = -qty;
    else continue;
    const key = `${a.accountId}|${a.assetSymbol}`;
    const list = out.get(key) ?? [];
    list.push({ date: iso(a.date), delta });
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((x, y) => x.date.localeCompare(y.date));
  return out;
}

const sharesHeldAt = (
  timeline: Map<string, { date: string; delta: number }[]>,
  key: string,
  date: string,
): number =>
  (timeline.get(key) ?? [])
    .filter((e) => e.date <= date)
    .reduce((s, e) => s + e.delta, 0);

type EventKind = 'EXIT' | 'OPEN';
interface TimelineEvent {
  date: string;
  kind: EventKind;
  leg: Leg;
}

/**
 * Exits sort before opens on the same day, so a put assigned in the morning has
 * already delivered its shares when the covered call is written that afternoon.
 * The visible consequence is that a same-day roll reads as one cycle ending and
 * another starting, which is what the share ledger actually did.
 */
const KIND_ORDER: Record<EventKind, number> = { EXIT: 0, OPEN: 1 };

export function buildCycles(
  legs: Leg[],
  activities: WireActivity[] = [],
  asOf: Date = new Date(),
): Cycle[] {
  const today = iso(asOf);
  const timeline = shareTimeline(activities);
  const equities = extractEquityEvents(activities);
  const byUnderlying = new Map<string, Leg[]>();

  for (const leg of legs) {
    const key = `${leg.accountId}|${leg.underlying}`;
    const bucket = byUnderlying.get(key) ?? [];
    bucket.push(leg);
    byUnderlying.set(key, bucket);
  }

  const cycles: Cycle[] = [];

  for (const [groupKey, groupLegs] of byUnderlying) {
    const events: TimelineEvent[] = [];
    for (const leg of groupLegs) {
      events.push({ date: leg.opened, kind: 'OPEN', leg });
      if (leg.closed) events.push({ date: leg.closed, kind: 'EXIT', leg });
    }
    events.sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate) return byDate;
      // One leg opened and closed the same day must still open before it
      // exits, or its exit lands with no cycle to apply it to and the cycle
      // never closes. Only across *different* legs does exit-first hold.
      if (a.leg.key === b.leg.key) return a.kind === 'OPEN' ? -1 : 1;
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.leg.key.localeCompare(b.leg.key);
    });

    let live: Cycle | null = null;
    let seq = 0;
    let openLegs = 0;
    let openPutNotional = 0;
    let peakCapital = 0;
    let closedByCall = false;

    const commit = (closeDate: string | null) => {
      if (!live) return;
      live.closed = closeDate;
      live.live = closeDate === null;
      live.days = daysBetween(live.opened, closeDate ?? today);
      live.premium = live.legs.reduce((s, l) => s + l.net, 0);
      live.total = live.premium + live.stockPnl;
      live.capital = Math.max(peakCapital, live.shareCostBasis);
      live.roc = live.capital > EPS ? live.total / live.capital : 0;
      live.annualized = (live.roc * 365) / live.days;
      cycles.push(live);
      live = null;
      openLegs = 0;
      openPutNotional = 0;
      peakCapital = 0;
      closedByCall = false;
    };

    const start = (leg: Leg): Cycle => ({
      key: `${groupKey}|${seq++}`,
      accountId: leg.accountId,
      accountName: leg.accountName,
      underlying: leg.underlying,
      currency: leg.currency,
      stage: 'CSP_OPEN',
      live: true,
      legs: [],
      shares: 0,
      shareCostBasis: 0,
      uncovered: false,
      opened: leg.opened,
      closed: null,
      days: 0,
      premium: 0,
      stockPnl: 0,
      total: 0,
      capital: 0,
      roc: 0,
      annualized: 0,
    });

    const mark = () => {
      if (!live) return;
      peakCapital = Math.max(peakCapital, live.shareCostBasis + openPutNotional);
    };

    for (const ev of events) {
      const { leg } = ev;

      if (ev.kind === 'OPEN') {
        if (!live) live = start(leg);
        live.legs.push(leg);
        openLegs++;
        if (leg.side === 'SHORT' && leg.kind === 'PUT') openPutNotional += leg.capital;

        if (leg.side === 'SHORT' && leg.kind === 'CALL') {
          const obligation = leg.contracts * leg.multiplier;
          const held = sharesHeldAt(timeline, `${leg.accountId}|${leg.underlying}`, leg.opened);
          if (held + EPS < obligation) live.uncovered = true;
        }
        mark();
        continue;
      }

      // EXIT. The leg was opened earlier, so a cycle exists.
      if (!live) continue;
      openLegs = Math.max(0, openLegs - 1);
      if (leg.side === 'SHORT' && leg.kind === 'PUT') {
        openPutNotional = Math.max(0, openPutNotional - leg.capital);
      }

      if (leg.outcome === 'ASSIGNED' && leg.side === 'SHORT') {
        const qty = leg.contracts * leg.multiplier;
        if (leg.kind === 'PUT') {
          live.shares += qty;
          live.shareCostBasis += leg.strike * qty;
          closedByCall = false;
        } else {
          const released = Math.min(live.shares, qty);
          if (released > EPS) {
            const avg = live.shareCostBasis / live.shares;
            live.stockPnl += (leg.strike - avg) * released;
            live.shares -= released;
            live.shareCostBasis -= avg * released;
          }
          closedByCall = live.shares <= EPS;
        }
      }
      mark();

      if (live.shares <= EPS && openLegs === 0) {
        live.stage = closedByCall ? 'CALLED_AWAY' : 'PREMIUM_KEPT';
        commit(ev.date);
      }
    }

    if (live) {
      const c: Cycle = live;
      const stillOpen = c.legs.filter((l) => l.outcome === 'OPEN');
      const openShortCall = stillOpen.some((l) => l.side === 'SHORT' && l.kind === 'CALL');
      const openShortPut = stillOpen.some((l) => l.side === 'SHORT' && l.kind === 'PUT');
      c.stage = openShortCall
        ? 'CC_OPEN'
        : c.shares > EPS
          ? 'ASSIGNED_HOLDING'
          : openShortPut
            ? 'CSP_OPEN'
            : stillOpen.length
              ? 'LONG_OPEN'
              : 'PREMIUM_KEPT';
      commit(null);
    }
  }

  // Live cycles first, then most recent. That is the order the question
  // "where am I right now" wants answered.
  return cycles.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      (b.closed ?? '9999').localeCompare(a.closed ?? '9999') ||
      b.opened.localeCompare(a.opened),
  );
}

/** The live cycle a leg belongs to, for badging a row in the UI. */
export function cycleForLeg(cycles: Cycle[], leg: Leg): Cycle | undefined {
  return cycles.find((c) => c.legs.some((l) => l.key === leg.key));
}

export interface SharePosition {
  accountId: string;
  accountName: string;
  underlying: string;
  currency: string;
  shares: number;
  costBasis: number;
}

/** Shares currently held because a put was assigned, by account and ticker. */
export function assignedShares(cycles: Cycle[]): SharePosition[] {
  return cycles
    .filter((c) => c.live && c.shares > EPS)
    .map((c) => ({
      accountId: c.accountId,
      accountName: c.accountName,
      underlying: c.underlying,
      currency: c.currency,
      shares: c.shares,
      costBasis: c.shareCostBasis,
    }))
    .sort((a, b) => b.costBasis - a.costBasis);
}

export type { EquityEvent };
