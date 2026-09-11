import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  AnimatedToggleGroup,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyPlaceholder,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TickerAvatar,
  cn,
  usePersistentState,
} from '@wealthfolio/ui';
import {
  buildLegs,
  groupByUnderlying,
  summarize,
  assetIdsBySymbol,
  type Leg,
  type Summary,
  type WireActivity,
} from '../lib/wheel';
import { assignedShares, buildCycles, cycleForLeg, stageLabel, type Cycle, type Stage } from '../lib/cycle';

const ALL = '__all__';

type ChartOpener = (optionId: string | undefined, stockId: string | undefined) => void;

const money = (n: number, ccy = 'USD') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: ccy,
    maximumFractionDigits: 0,
  }).format(n);

const pct = (n: number, digits = 1) =>
  `${n >= 0 ? '' : '-'}${Math.abs(n * 100).toFixed(digits)}%`;

const signClass = (n: number) =>
  n > 0 ? 'text-success' : n < 0 ? 'text-destructive' : 'text-muted-foreground';

const today = () => new Date().toISOString().slice(0, 10);

const daysUntil = (date: string) =>
  Math.round((Date.parse(date) - Date.parse(today())) / 86400000);

// `info` is not mapped to a colour in every host theme, so the palette here
// stays on variants that are.
const STAGE_VARIANT: Record<Stage, 'default' | 'secondary' | 'success' | 'warning' | 'outline'> = {
  CSP_OPEN: 'default',
  ASSIGNED_HOLDING: 'warning',
  CC_OPEN: 'success',
  CALLED_AWAY: 'secondary',
  PREMIUM_KEPT: 'secondary',
  LONG_OPEN: 'outline',
};

const OUTCOME_LABEL: Record<Leg['outcome'], string> = {
  OPEN: 'open',
  CLOSED: 'closed',
  ASSIGNED: 'assigned',
  EXPIRED: 'expired',
};

const OUTCOME_VARIANT: Record<Leg['outcome'], 'default' | 'secondary' | 'warning'> = {
  OPEN: 'default',
  CLOSED: 'secondary',
  ASSIGNED: 'warning',
  EXPIRED: 'secondary',
};

function Stat({ label, value, hint, tone }: {
  label: string; value: string; hint?: string; tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function ContractCell({ leg }: { leg: Leg }) {
  return (
    <span className="font-medium whitespace-nowrap">
      <span className="text-muted-foreground">{leg.side === 'SHORT' ? '-' : '+'}</span>{' '}
      {leg.underlying} {leg.kind === 'PUT' ? 'P' : 'C'}
      {leg.strike.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      <span className="ml-2 text-xs text-muted-foreground">exp {leg.expiry}</span>
    </span>
  );
}

function ChartButton({ label, optionId, stockId, onOpen }: {
  label: string;
  optionId?: string;
  stockId?: string;
  onOpen: (optionId: string | undefined, stockId: string | undefined) => void;
}) {
  // Nothing to route to at all: render nothing rather than a dead control.
  if (!optionId && !stockId) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      title={`Open ${label} price chart`}
      onClick={() => onOpen(optionId, stockId)}
    >
      <Icons.ChartBar className="h-4 w-4" />
    </Button>
  );
}

function OpenPositions({ legs, cycles, assetIds, ccy, onChart }: {
  legs: Leg[];
  cycles: Cycle[];
  assetIds: Record<string, string>;
  ccy: string;
  onChart: ChartOpener;
}) {
  if (!legs.length) return null;
  return (
    <Card>
      <CardHeader className="py-4">
        <CardTitle className="text-base">
          Open positions
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {legs.length} {legs.length === 1 ? 'leg' : 'legs'} · soonest expiry first
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contract</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead className="text-right">DTE</TableHead>
              <TableHead className="text-right">Premium</TableHead>
              <TableHead className="text-right">Capital</TableHead>
              <TableHead className="text-right">Annualized</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {legs.map((l) => {
              const cycle = cycleForLeg(cycles, l);
              const dte = daysUntil(l.expiry);
              return (
                <TableRow key={l.key}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <TickerAvatar symbol={l.underlying} className="h-5 w-5" />
                      <ContractCell leg={l} />
                    </span>
                  </TableCell>
                  <TableCell>
                    {cycle ? (
                      <span className="flex items-center gap-2">
                        <Badge variant={STAGE_VARIANT[cycle.stage]}>{stageLabel(cycle.stage)}</Badge>
                        {cycle.uncovered ? (
                          <span className="text-xs text-destructive">uncovered</span>
                        ) : cycle.shares > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {cycle.shares.toLocaleString()} sh
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.contracts}</TableCell>
                  <TableCell className="whitespace-nowrap">{l.opened}</TableCell>
                  <TableCell
                    className={cn('text-right tabular-nums', dte <= 7 ? 'text-warning' : '')}
                  >
                    {dte}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${signClass(l.net)}`}>
                    {money(l.net, l.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {money(l.capital, l.currency)}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${signClass(l.annualized)}`}>
                    {pct(l.annualized)}
                  </TableCell>
                  <TableCell className="text-right">
                    <ChartButton
                      label={l.symbol}
                      optionId={assetIds[l.symbol]}
                      stockId={assetIds[l.underlying]}
                      onOpen={onChart}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5}>Committed</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(legs.reduce((s, l) => s + l.net, 0), ccy)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(legs.reduce((s, l) => s + l.capital, 0), ccy)}
              </TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

function LegsTable({ legs, assetIds, onChart }: {
  legs: Leg[];
  assetIds: Record<string, string>;
  onChart: ChartOpener;
}) {
  const total = summarize(legs);
  const ccy = legs[0]?.currency ?? 'USD';
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contract</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead>Opened</TableHead>
          <TableHead>Closed</TableHead>
          <TableHead className="text-right">Days</TableHead>
          <TableHead className="text-right">Net premium</TableHead>
          <TableHead className="text-right">Capital</TableHead>
          <TableHead className="text-right">RoC</TableHead>
          <TableHead className="text-right">Annualized</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {legs.map((l) => (
          <TableRow key={l.key}>
            <TableCell><ContractCell leg={l} /></TableCell>
            <TableCell className="text-right tabular-nums">{l.contracts}</TableCell>
            <TableCell className="whitespace-nowrap">{l.opened}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {l.closed ?? '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums">{l.days}</TableCell>
            <TableCell className={`text-right tabular-nums font-medium ${signClass(l.net)}`}>
              {money(l.net, l.currency)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {money(l.capital, l.currency)}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${signClass(l.roc)}`}>
              {pct(l.roc, 2)}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${signClass(l.annualized)}`}>
              {pct(l.annualized)}
            </TableCell>
            <TableCell>
              <Badge variant={OUTCOME_VARIANT[l.outcome]}>{OUTCOME_LABEL[l.outcome]}</Badge>
            </TableCell>
            <TableCell className="text-right">
              <ChartButton
                label={l.symbol}
                optionId={assetIds[l.symbol]}
                stockId={assetIds[l.underlying]}
                onOpen={onChart}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={5}>{legs.length} legs</TableCell>
          <TableCell className={`text-right tabular-nums ${signClass(total.netPremium)}`}>
            {money(total.netPremium, ccy)}
          </TableCell>
          <TableCell colSpan={5} />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function UnderlyingCard({ underlying, legs, cycles, assetIds, onChart, expanded, onToggle }: {
  underlying: string;
  legs: Leg[];
  cycles: Cycle[];
  assetIds: Record<string, string>;
  onChart: ChartOpener;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const openLegs = legs.filter((l) => l.outcome === 'OPEN');
  const closedLegs = legs.filter((l) => l.outcome !== 'OPEN');
  const [view, setView] = usePersistentState<'open' | 'closed'>(
    `wheel.view.${underlying}`,
    'open',
  );
  const summary = summarize(legs);
  const ccy = legs[0]?.currency ?? 'USD';
  const liveCycle = cycles.find((c) => c.underlying === underlying && c.live);

  // A group with nothing open has nothing to show under the default Open view,
  // so fall back rather than render an empty table.
  const effective = view === 'open' && !openLegs.length ? 'closed' : view;
  const shown = effective === 'open' ? openLegs : closedLegs;

  return (
    <Card>
      <Collapsible open={expanded} onOpenChange={onToggle}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="flex flex-row items-center justify-between gap-4 py-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icons.ChevronRight
                className={cn('h-4 w-4 text-muted-foreground', expanded ? 'rotate-90' : '')}
              />
              <TickerAvatar symbol={underlying} className="h-5 w-5" />
              {underlying}
              {liveCycle ? (
                <Badge variant={STAGE_VARIANT[liveCycle.stage]}>
                  {stageLabel(liveCycle.stage)}
                </Badge>
              ) : null}
              <span className="text-sm font-normal text-muted-foreground">
                {openLegs.length ? `${openLegs.length} open · ` : ''}
                {summary.legs} legs · {pct(summary.winRate, 0)} win
              </span>
            </CardTitle>
            <div className={`text-lg font-semibold tabular-nums ${signClass(summary.netPremium)}`}>
              {money(summary.netPremium, ccy)}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="mb-3">
              <AnimatedToggleGroup<'open' | 'closed'>
                value={effective}
                onValueChange={setView}
                size="xs"
                aria-label="Leg status"
                items={[
                  { value: 'open', label: `Open (${openLegs.length})` },
                  { value: 'closed', label: `Closed (${closedLegs.length})` },
                ]}
              />
            </div>
            {shown.length ? (
              <LegsTable legs={shown} assetIds={assetIds} onChart={onChart} />
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No {effective} legs for {underlying}.
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function WheelPage({ ctx }: { ctx: AddonContext }) {
  const [account, setAccount] = useState<string>(ALL);
  // Only explicit user choices are stored; everything else follows the
  // "expanded when something is open" default below.
  const [overrides, setOverrides] = usePersistentState<Record<string, boolean>>(
    'wheel.expanded',
    {},
  );

  const accounts = useQuery({
    queryKey: ['wheel', 'accounts'],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  const activities = useQuery({
    queryKey: ['wheel', 'activities'],
    // One call pulls the whole history; getAll is search() with an unbounded page.
    // Double-cast: the published ActivityDetails omits the wire-only fields
    // (instrumentType, assetContractMultiplier) that WireActivity relies on.
    queryFn: () => ctx.api.activities.getAll() as unknown as Promise<WireActivity[]>,
  });

  const all = (activities.data ?? []) as WireActivity[];
  const scoped = useMemo(
    () => (account === ALL ? all : all.filter((a) => a.accountId === account)),
    [all, account],
  );

  // Equity activities stay in scope on purpose: they are what tells an
  // assignment from a worthless expiry, and they cost no extra permission.
  const legs = useMemo(() => buildLegs(scoped), [scoped]);
  const cycles = useMemo(() => buildCycles(legs, scoped), [legs, scoped]);
  const assetIds = useMemo(() => assetIdsBySymbol(all), [all]);
  const total: Summary = useMemo(() => summarize(legs), [legs]);
  const groups = useMemo(() => groupByUnderlying(legs), [legs]);
  const shares = useMemo(() => assignedShares(cycles), [cycles]);

  const openLegs = useMemo(
    () =>
      legs
        .filter((l) => l.outcome === 'OPEN')
        .sort((a, b) => a.expiry.localeCompare(b.expiry) || b.capital - a.capital),
    [legs],
  );

  const ccy = legs[0]?.currency ?? 'USD';
  const shareCount = shares.reduce((s, p) => s + p.shares, 0);
  const shareBasis = shares.reduce((s, p) => s + p.costBasis, 0);

  // Prefer the contract's own chart, but a contract the providers never
  // returned quotes for — which is most of them once they are closed or
  // assigned — would open an empty page. Ask first, and fall back to the
  // underlying when there is nothing to plot.
  const openChart: ChartOpener = async (optionId, stockId) => {
    const go = (id: string) => ctx.api.navigation.navigate(`/holdings/${encodeURIComponent(id)}`);
    if (optionId) {
      try {
        const history = await ctx.api.quotes.getHistory(optionId);
        if (history && history.length) return void (await go(optionId));
      } catch {
        // Permission denied or the asset is unknown: the fallback still works.
      }
    }
    if (stockId) return void (await go(stockId));
    if (optionId) return void (await go(optionId));
  };

  if (activities.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (activities.isError) {
    return (
      <div className="p-6 text-destructive">
        Could not load activities: {String((activities.error as Error)?.message ?? '')}
      </div>
    );
  }

  return (
    <Page>
      {/* PageHeader renders children only when there is no heading, so the
          filter has to go through `actions`. */}
      <PageHeader
        heading="Wheel"
        text="Where each position sits in the cycle, and what the capital behind it earned."
        actions={
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="h-9 w-48">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All accounts</SelectItem>
              {(accounts.data ?? []).map((a: { id: string; name: string }) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <PageContent>
        {legs.length === 0 ? (
          <EmptyPlaceholder
            title="No option activity"
            description="Legs are built from activities whose asset is an option contract — check that your option trades imported with an instrument type of OPTION."
          >
            <EmptyPlaceholder.Icon name="Percent" />
          </EmptyPlaceholder>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat
                label="Open premium"
                value={money(total.unrealized, ccy)}
                hint={`${total.open} open · ${money(total.capitalAtRisk, ccy)} committed`}
                tone={signClass(total.unrealized)}
              />
              <Stat
                label="Shares held"
                value={shareCount.toLocaleString()}
                hint={shareCount ? `assigned · ${money(shareBasis, ccy)} basis` : 'none assigned'}
              />
              <Stat
                label="Realized"
                value={money(total.realized, ccy)}
                hint={`${total.closed} closed · ${pct(total.winRate, 0)} win`}
                tone={signClass(total.realized)}
              />
              <Stat
                label="Net premium"
                value={money(total.netPremium, ccy)}
                hint={`${total.legs} legs`}
                tone={signClass(total.netPremium)}
              />
              <Stat
                label="Annualized RoC"
                value={pct(total.avgAnnualized)}
                hint="capital-weighted"
                tone={signClass(total.avgAnnualized)}
              />
            </div>

            <div className="mt-6">
              <OpenPositions
                legs={openLegs}
                cycles={cycles}
                assetIds={assetIds}
                ccy={ccy}
                onChart={openChart}
              />
            </div>

            <div className="mt-6 space-y-4">
              {groups.map((g) => {
                const hasOpen = g.legs.some((l) => l.outcome === 'OPEN');
                const expanded = overrides[g.underlying] ?? hasOpen;
                return (
                  <UnderlyingCard
                    key={g.underlying}
                    underlying={g.underlying}
                    legs={g.legs}
                    cycles={cycles}
                    assetIds={assetIds}
                    onChart={openChart}
                    expanded={expanded}
                    onToggle={(open) =>
                      setOverrides((prev) => ({ ...prev, [g.underlying]: open }))
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </PageContent>
    </Page>
  );
}
