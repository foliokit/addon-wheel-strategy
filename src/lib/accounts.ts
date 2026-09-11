/**
 * Which accounts the account filter offers.
 *
 * Only a SECURITIES account can hold an option contract, and only an account
 * tracked by transactions has the activity history the legs are built from:
 * HOLDINGS mode accepts nothing but cash and income activities (the host's
 * activity-restrictions.ts), so no leg can come from it. NOT_SET is how the
 * host stores "not chosen yet" and behaves as transactions, so it stays in.
 */
export interface FilterableAccount {
  id: string;
  name: string;
  accountType: string;
  trackingMode?: string | null;
}

export function wheelAccounts<A extends FilterableAccount>(accounts: A[]): A[] {
  return accounts.filter(
    (a) => a.accountType === 'SECURITIES' && a.trackingMode !== 'HOLDINGS',
  );
}
