import { describe, expect, it } from 'vitest';
import { assetIdsBySymbol, buildLegs, groupByUnderlying, parseOsi, summarize, type WireActivity } from './wheel';

let seq = 0;
const act = (p: Partial<WireActivity>): WireActivity => ({
  id: `a${seq++}`,
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
/** The share leg of an assignment: what tells a real assignment from a worthless expiry. */
const stock = (symbol: string, qty: number, price: number, date: string, direction: 'BUY' | 'SELL' = 'BUY') =>
  act({ activityType: direction, subtype: null, assetSymbol: symbol, instrumentType: 'EQUITY',
        assetId: `asset-${symbol}`, quantity: String(qty), amount: String(qty * price),
        unitPrice: String(price), date, assetContractMultiplier: null });

describe('parseOsi', () => {
  it('decodes an OSI symbol', () => {
    expect(parseOsi('MU261002C01000000')).toEqual({
      underlying: 'MU', expiry: '2026-10-02', kind: 'CALL', strike: 1000,
    });
  });
  it('tolerates the padding spaces brokers emit', () => {
    expect(parseOsi('INTC  270319C00080000')?.strike).toBe(80);
  });
  it('handles sub-dollar strikes', () => {
    expect(parseOsi('SNXX260925P00015000')?.strike).toBe(15);
  });
  it('rejects a plain equity ticker', () => {
    expect(parseOsi('GOOG')).toBeNull();
  });
});

describe('leg pairing', () => {
  // Expected values are worked out by hand rather than read back from the
  // engine, so a change to the money math fails here instead of drifting.
  it('matches the MU $1,100 put assigned after 35 days', () => {
    const legs = buildLegs([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'), // the shares the assignment delivered
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      side: 'SHORT', kind: 'PUT', strike: 1100, net: 10500, days: 35,
      outcome: 'ASSIGNED', capital: 110000,
    });
    expect(legs[0].roc).toBeCloseTo(0.09545, 4);
  });

  it('matches the MU $920 covered call bought back for a 3,300 gain', () => {
    const legs = buildLegs([
      sto('MU260904C00920000', 1, 8100, '2026-08-04'),
      btc('MU260904C00920000', 1, 4800, '2026-08-07'),
    ]);
    expect(legs[0]).toMatchObject({ kind: 'CALL', net: 3300, days: 3, outcome: 'CLOSED' });
  });

  it('matches a 10-contract SNXX put roll', () => {
    const legs = buildLegs([
      sto('SNXX260911P00009000', 10, 1800, '2026-08-06'),
      btc('SNXX260911P00009000', 10, 850, '2026-08-13'),
    ]);
    expect(legs[0]).toMatchObject({ contracts: 10, net: 950, days: 7, capital: 9000 });
  });

  it('leaves an unclosed short open and marks it', () => {
    const legs = buildLegs([sto('MU261002C01000000', 2, 11000, '2026-08-25')], new Date('2026-09-09'));
    expect(legs[0]).toMatchObject({ outcome: 'OPEN', closed: null, net: 11000, days: 15, capital: 200000 });
  });

  it('splits one close across two earlier opens, FIFO', () => {
    const legs = buildLegs([
      sto('MU260904C00920000', 1, 1000, '2026-08-01'),
      sto('MU260904C00920000', 1, 2000, '2026-08-02'),
      btc('MU260904C00920000', 2, 600, '2026-08-05'),
    ]);
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.net)).toEqual([700, 1700]);
  });
});

describe('intent inference when subtype is absent', () => {
  // Activities added over MCP cannot carry a subtype, so intent has to be
  // inferred from open interest rather than assumed from BUY/SELL.
  it('treats a bare SELL as sell-to-open and the later BUY as the close', () => {
    const legs = buildLegs([
      act({ activityType: 'SELL', subtype: null, assetSymbol: 'INTC260529C00080000', amount: '223', date: '2026-04-23' }),
      act({ activityType: 'BUY', subtype: null, assetSymbol: 'INTC260529C00080000', amount: '765', date: '2026-04-24' }),
    ]);
    expect(legs[0]).toMatchObject({ side: 'SHORT', net: -542, outcome: 'CLOSED' });
  });

  it('treats a bare BUY with no open interest as buy-to-open, and expiry as a loss', () => {
    const legs = buildLegs([
      act({ activityType: 'BUY', subtype: null, assetSymbol: 'META260522C00665000', quantity: '4', amount: '110.79', date: '2026-05-19' }),
      expire('META260522C00665000', 4, '2026-05-22'),
    ]);
    expect(legs[0].side).toBe('LONG');
    expect(legs[0].outcome).toBe('EXPIRED');
    expect(legs[0].net).toBeCloseTo(-110.79, 2);   // long premium is lost, not kept
  });
});

describe('assignment detection', () => {
  // The broker reports assignment and worthless expiry with the same
  // OPTION_EXPIRY subtype. The share leg is the only thing that separates them.
  it('reads an expiry with no share movement as expired worthless', () => {
    const legs = buildLegs([
      sto('MU260529P00955000', 1, 635, '2026-05-01'),
      expire('MU260529P00955000', 1, '2026-05-29'),
    ]);
    expect(legs[0].outcome).toBe('EXPIRED');
  });

  it('reads an expiry paired with a share buy as an assignment', () => {
    const legs = buildLegs([
      sto('MU260529P00955000', 1, 635, '2026-05-01'),
      expire('MU260529P00955000', 1, '2026-05-29'),
      stock('MU', 100, 955, '2026-05-29'),
    ]);
    expect(legs[0].outcome).toBe('ASSIGNED');
  });

  it('honours an early assignment, dated before the contract expiry', () => {
    const legs = buildLegs([
      sto('MU260807P01040000', 1, 11800, '2026-07-01'),
      expire('MU260807P01040000', 1, '2026-08-06'),
      stock('MU', 100, 1040, '2026-08-06'),
    ]);
    expect(legs[0]).toMatchObject({ outcome: 'ASSIGNED', expiry: '2026-08-07', closed: '2026-08-06' });
  });

  it('will not let two same-day expiries claim the same share buy', () => {
    const legs = buildLegs([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      sto('MU260731P00900000', 1, 2000, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      expire('MU260731P00900000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31'), // only enough shares for one of them
    ]);
    const byStrike = Object.fromEntries(legs.map((l) => [l.strike, l.outcome]));
    expect(byStrike).toEqual({ 1100: 'ASSIGNED', 900: 'EXPIRED' });
  });

  it('covers a two-contract assignment from a single 200-share fill', () => {
    const legs = buildLegs([
      sto('MU260731P01100000', 2, 21000, '2026-06-26'),
      expire('MU260731P01100000', 2, '2026-07-31'),
      stock('MU', 200, 1100, '2026-07-31'),
    ]);
    expect(legs[0]).toMatchObject({ outcome: 'ASSIGNED', contracts: 2 });
  });

  it('reads a call expiry paired with a share sale as called away', () => {
    const legs = buildLegs([
      sto('MU261002C01000000', 1, 5500, '2026-08-25'),
      expire('MU261002C01000000', 1, '2026-10-02'),
      stock('MU', 100, 1000, '2026-10-02', 'SELL'),
    ]);
    expect(legs[0].outcome).toBe('ASSIGNED');
  });

  it('does not treat a share buy in another account as this account\'s assignment', () => {
    const legs = buildLegs([
      sto('MU260731P01100000', 1, 10500, '2026-06-26'),
      expire('MU260731P01100000', 1, '2026-07-31'),
      { ...stock('MU', 100, 1100, '2026-07-31'), accountId: 'other' },
    ]);
    expect(legs[0].outcome).toBe('EXPIRED');
  });

  it('leaves a long expiry alone even when shares moved the same day', () => {
    const legs = buildLegs([
      act({ activityType: 'BUY', subtype: 'POSITION_OPEN', assetSymbol: 'MU260731C01100000', quantity: '1', amount: '500', date: '2026-07-01' }),
      expire('MU260731C01100000', 1, '2026-07-31'),
      stock('MU', 100, 1100, '2026-07-31', 'SELL'),
    ]);
    expect(legs[0]).toMatchObject({ side: 'LONG', outcome: 'EXPIRED' });
  });
});

describe('option detection', () => {
  it('ignores equity activity entirely', () => {
    expect(buildLegs([act({ assetSymbol: 'GOOG', instrumentType: 'EQUITY' })])).toHaveLength(0);
  });
  it('falls back to symbol shape when instrumentType is missing', () => {
    const legs = buildLegs([
      sto('MU260731P01100000', 1, 100, '2026-06-26'),
    ].map((a) => ({ ...a, instrumentType: null })));
    expect(legs).toHaveLength(1);
  });
});

describe('assetIdsBySymbol', () => {
  it('maps contracts as well as tickers, so a leg can link to its own chart', () => {
    const map = assetIdsBySymbol([
      { ...sto('MU260731P01100000', 1, 10500, '2026-06-26'), assetId: 'opt-1' },
      stock('MU', 100, 1100, '2026-07-31'),
    ]);
    expect(map).toEqual({ MU260731P01100000: 'opt-1', MU: 'asset-MU' });
  });

  it('keeps a padded symbol separate — the host stores it as its own asset', () => {
    const map = assetIdsBySymbol([
      { ...sto('MU    260529P00955000', 1, 635, '2026-05-01'), assetId: 'padded' },
      { ...sto('MU260529P00955000', 1, 635, '2026-05-01'), assetId: 'bare' },
    ]);
    expect(map['MU    260529P00955000']).toBe('padded');
    expect(map['MU260529P00955000']).toBe('bare');
  });

  it('skips activities with no asset id', () => {
    expect(assetIdsBySymbol([sto('MU260731P01100000', 1, 1, '2026-06-26')])).toEqual({});
  });
});

describe('summary', () => {
  const legs = buildLegs([
    sto('MU260731P01100000', 1, 10500, '2026-06-26'),
    expire('MU260731P01100000', 1, '2026-07-31'),
    sto('SNXX260911P00009000', 10, 1800, '2026-08-06'),
    btc('SNXX260911P00009000', 10, 850, '2026-08-13'),
    sto('MU261002C01000000', 2, 11000, '2026-08-25'),
  ], new Date('2026-09-09'));

  it('separates realized from open', () => {
    const s = summarize(legs);
    expect(s).toMatchObject({ legs: 3, closed: 2, open: 1, realized: 11450, unrealized: 11000, winRate: 1 });
  });

  it('weights annualized return by capital so small fast legs cannot dominate', () => {
    const s = summarize(legs);
    // 110k at 99.5% and 9k at 550% -> far nearer the large position's rate.
    expect(s.avgAnnualized).toBeGreaterThan(1.0);
    expect(s.avgAnnualized).toBeLessThan(1.5);
  });

  it('groups by underlying, richest first', () => {
    const g = groupByUnderlying(legs);
    expect(g.map((x) => x.underlying)).toEqual(['MU', 'SNXX']);
  });
});
