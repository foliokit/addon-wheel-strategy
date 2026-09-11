import { describe, expect, it } from 'vitest';
import { buildLegs, type WireActivity } from './wheel';
import { assignedShares, buildCycles, stageLabel } from './cycle';

let seq = 0;
const act = (p: Partial<WireActivity>): WireActivity => ({
  id: `c${seq++}`,
  accountId: 'acct',
  accountName: 'Margin',
  activityType: 'SELL',
  subtype: null,
  date: '2026-01-01',
  quantity: '1',
  amount: '0',
  assetSymbol: 'MU260101P00100000',
  currency: 'USD',
  instrumentType: 'OPTION',
  assetContractMultiplier: '100',
  ...p,
});

const sto = (symbol: string, qty: number, amount: number, date: string) =>
  act({ activityType: 'SELL', subtype: 'POSITION_OPEN', assetSymbol: symbol, quantity: String(qty), amount: String(amount), date });
const btc = (symbol: string, qty: number, amount: number, date: string) =>
  act({ activityType: 'BUY', subtype: 'POSITION_CLOSE', assetSymbol: symbol, quantity: String(qty), amount: String(amount), date });
const expire = (symbol: string, qty: number, date: string) =>
  act({ activityType: 'ADJUSTMENT', subtype: 'OPTION_EXPIRY', assetSymbol: symbol, quantity: String(qty), amount: null, date });
const stock = (symbol: string, qty: number, price: number, date: string, direction: 'BUY' | 'SELL' = 'BUY') =>
  act({ activityType: direction, subtype: null, assetSymbol: symbol, instrumentType: 'EQUITY',
        assetId: `asset-${symbol}`, quantity: String(qty), amount: String(qty * price),
        unitPrice: String(price), date, assetContractMultiplier: null });

const cyclesOf = (acts: WireActivity[], asOf = new Date('2026-09-09')) =>
  buildCycles(buildLegs(acts, asOf), acts, asOf);

describe('cycle stages', () => {
  it('a live cash-secured put is CSP_OPEN with no shares', () => {
    const [c] = cyclesOf([sto('MU261002P01000000', 1, 5000, '2026-08-25')]);
    expect(c).toMatchObject({ stage: 'CSP_OPEN', shares: 0, live: true, premium: 5000 });
    expect(c.capital).toBe(100000);
  });

  it('a put bought back closes the cycle as PREMIUM_KEPT', () => {
    const [c] = cyclesOf([
      sto('SNXX260911P00009000', 10, 1800, '2026-08-06'),
      btc('SNXX260911P00009000', 10, 850, '2026-08-13'),
    ]);
    expect(c).toMatchObject({ stage: 'PREMIUM_KEPT', live: false, shares: 0, premium: 950, stockPnl: 0 });
    expect(c.closed).toBe('2026-08-13');
  });

  it('a put that expires worthless also ends as PREMIUM_KEPT', () => {
    const [c] = cyclesOf([
      sto('MU260529P00955000', 1, 635, '2026-05-01'),
      expire('MU260529P00955000', 1, '2026-05-29'),
    ]);
    expect(c).toMatchObject({ stage: 'PREMIUM_KEPT', live: false, shares: 0 });
  });

  it('an assigned put leaves the cycle holding shares at the strike', () => {
    const [c] = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'),
    ]);
    expect(c).toMatchObject({
      stage: 'ASSIGNED_HOLDING', live: true, shares: 100, shareCostBasis: 110000, premium: 10500,
    });
  });

  it('writing a call against assigned shares moves the same cycle to CC_OPEN', () => {
    const [c] = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'),
      sto('MU260904C01200000', 1, 8100, '2026-08-04'),
    ]);
    expect(c).toMatchObject({ stage: 'CC_OPEN', live: true, shares: 100, uncovered: false });
    expect(c.legs).toHaveLength(2); // put and call are one cycle, not two
    expect(c.premium).toBe(18600);
  });

  it('being called away closes the cycle and books the share gain', () => {
    const [c] = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'),
      sto('MU260918C01200000', 1, 3000, '2026-08-01'),
      expire('MU260918C01200000', 1, '2026-09-18'),
      stock('MU', 100, 1200, '2026-09-18', 'SELL'),
    ], new Date('2026-09-30'));
    expect(c).toMatchObject({
      stage: 'CALLED_AWAY', live: false, shares: 0,
      premium: 13500, stockPnl: 10000, total: 23500, capital: 110000,
    });
    expect(c.closed).toBe('2026-09-18');
    expect(c.roc).toBeCloseTo(23500 / 110000, 6);
  });

  it('separates premium from share P&L rather than blending them', () => {
    const [c] = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'),
      sto('MU260918C01000000', 1, 3000, '2026-08-01'),
      expire('MU260918C01000000', 1, '2026-09-18'),
      stock('MU', 100, 1000, '2026-09-18', 'SELL'), // called away $100 below basis
    ], new Date('2026-09-30'));
    expect(c.premium).toBe(13500);
    expect(c.stockPnl).toBe(-10000); // the loss the premium was covering
    expect(c.total).toBe(3500);
  });
});

describe('coverage', () => {
  it('flags a call written with no shares behind it', () => {
    const [c] = cyclesOf([sto('MU261002C01000000', 1, 5500, '2026-08-25')]);
    expect(c).toMatchObject({ stage: 'CC_OPEN', uncovered: true, shares: 0 });
  });

  it('treats shares transferred in as covering, without crediting the cycle', () => {
    const [c] = cyclesOf([
      act({ activityType: 'TRANSFER_IN', subtype: null, assetSymbol: 'MU', instrumentType: 'EQUITY',
            quantity: '100', amount: '90000', unitPrice: '900', date: '2026-04-14', assetContractMultiplier: null }),
      sto('MU261002C01000000', 1, 5500, '2026-08-25'),
    ]);
    expect(c).toMatchObject({ stage: 'CC_OPEN', uncovered: false, shares: 0, shareCostBasis: 0 });
  });
});

describe('grouping', () => {
  it('keeps the same underlying in two accounts as two cycles', () => {
    const [a, b] = cyclesOf([
      sto('MU261002P01000000', 1, 5000, '2026-08-25'),
      { ...sto('MU261002P01000000', 1, 4000, '2026-08-25'), accountId: 'ibkr', accountName: 'IBKR' },
    ]);
    expect([a.accountId, b.accountId].sort()).toEqual(['acct', 'ibkr']);
    expect(a.legs).toHaveLength(1);
    expect(b.legs).toHaveLength(1);
  });

  it('starts a fresh cycle after the previous one closes', () => {
    const cs = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      btc('MU260731P01100000', 1, 500, '2026-07-10'),
      sto('MU260904P01000000', 1, 3000, '2026-08-01'),
    ]);
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.stage)).toEqual(['CSP_OPEN', 'PREMIUM_KEPT']); // live first
  });

  it('closes a leg that opened and expired on the same day', () => {
    // Sold and expired on the same day. If the exit sorts before the open it
    // lands with no cycle and leaves a phantom live one.
    const cs = cyclesOf([
      act({ activityType: 'SELL', subtype: 'POSITION_OPEN', assetSymbol: 'MU260529P00955000', amount: '635', date: '2026-05-29' }),
      expire('MU260529P00955000', 1, '2026-05-29'),
    ]);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ stage: 'PREMIUM_KEPT', live: false, premium: 635 });
  });

  it('sorts live cycles ahead of finished ones', () => {
    const cs = cyclesOf([
      sto('SNXX260911P00009000', 10, 1800, '2026-08-06'),
      btc('SNXX260911P00009000', 10, 850, '2026-08-13'),
      sto('MU261002P01000000', 1, 5000, '2026-08-25'),
    ]);
    expect(cs[0].live).toBe(true);
    expect(cs[0].underlying).toBe('MU');
  });

  it('reports assigned share positions for the summary tiles', () => {
    const cs = cyclesOf([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'),
    ]);
    expect(assignedShares(cs)).toEqual([
      { accountId: 'acct', accountName: 'Margin', underlying: 'MU', currency: 'USD', shares: 100, costBasis: 110000 },
    ]);
  });
});

describe('stageLabel', () => {
  it('names every stage', () => {
    expect(stageLabel('CSP_OPEN')).toBe('Cash-secured put');
    expect(stageLabel('CC_OPEN')).toBe('Covered call');
    expect(stageLabel('CALLED_AWAY')).toBe('Called away');
  });
});
