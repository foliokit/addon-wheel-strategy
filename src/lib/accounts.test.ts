import { describe, expect, it } from 'vitest';
import { wheelAccounts } from './accounts';

const acct = (name: string, accountType: string, trackingMode?: string | null) => ({
  id: name.toLowerCase(),
  name,
  accountType,
  trackingMode,
});

describe('wheelAccounts', () => {
  it('keeps a securities account tracked by transactions', () => {
    expect(wheelAccounts([acct('Margin', 'SECURITIES', 'TRANSACTIONS')])).toHaveLength(1);
  });

  it('drops cash, credit-card and crypto accounts', () => {
    expect(
      wheelAccounts([
        acct('Chequing', 'CASH', 'TRANSACTIONS'),
        acct('Visa', 'CREDIT_CARD', 'TRANSACTIONS'),
        acct('Cold wallet', 'CRYPTOCURRENCY', 'TRANSACTIONS'),
      ]),
    ).toEqual([]);
  });

  it('drops a securities account tracked by holdings', () => {
    expect(wheelAccounts([acct('Advisor', 'SECURITIES', 'HOLDINGS')])).toEqual([]);
  });

  it('keeps NOT_SET, which the host treats as transactions', () => {
    expect(wheelAccounts([acct('New', 'SECURITIES', 'NOT_SET')])).toHaveLength(1);
    expect(wheelAccounts([acct('Older', 'SECURITIES', null)])).toHaveLength(1);
  });

  it('preserves the host order', () => {
    const kept = wheelAccounts([
      acct('Margin', 'SECURITIES', 'TRANSACTIONS'),
      acct('Chequing', 'CASH', 'TRANSACTIONS'),
      acct('Retirement', 'SECURITIES', 'TRANSACTIONS'),
    ]);
    expect(kept.map((a) => a.name)).toEqual(['Margin', 'Retirement']);
  });
});
