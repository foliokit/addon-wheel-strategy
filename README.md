# Wheel

A Wealthfolio addon for running the options wheel. It reconstructs your cycles
from activity history and shows where each position sits — cash-secured put,
holding assigned shares, covered call, called away — alongside what the capital
behind it actually earned.

Wealthfolio models short option lots correctly, but reports them per contract.
This adds the view a wheel trader wants.

## What you get

**Open positions first.** Every live leg across all underlyings, soonest expiry
first, each tagged with its stage in the cycle and how many days it has left.

**Real cycles, not isolated legs.** A put that gets assigned, the shares it
delivers, the call written against them, and the call that hands them back are
one cycle. Premium and share P&L are reported separately, so a covered call
that capped your upside doesn't hide inside a premium number.

**Assignment told apart from expiry.** Brokers report both as the same expiry
event. This pairs each one against the share movement it caused — an assigned
put has a matching stock buy at the strike, a worthless expiry has nothing — so
"premium kept" and "you now own 100 shares" stop looking identical.

**Collapsible history per underlying**, defaulting to open legs with a toggle
for closed ones. Groups holding something live start expanded.

**Return on capital committed** — strike notional for a short (a cash-secured
put, or the proceeds a covered call gives up), premium paid for a long —
annualized by days held, and capital-weighted across positions so a 2,000%
one-day leg on $10k cannot drown out a $110k position.

Each leg links to its contract's price chart in Wealthfolio, falling back to
the underlying's when the contract has no price history — which is typical once
a contract has closed or been assigned.

## Permissions

Read-only, and three: `activities:getAll`, `accounts:getAll`, and
`quotes:getHistory`.

Detecting assignments needs share activity, but that arrives in the same
activity feed the options come from — so cycle tracking costs no extra
permission. `quotes:getHistory` is used for one thing only: checking whether a
contract has any price history before opening its chart, so a leg with none
falls back to the underlying instead of showing an empty page. Chart links
themselves use the host's own navigation, which every addon has.

## Install

Download the zip from the [releases page](https://github.com/foliokit/addon-wheel-strategy/releases), then in Wealthfolio:
**Settings → Add-ons → Install from file**.

## Three things that will bite you if you fork this

1. **The canonical option subtypes are `POSITION_OPEN`, `POSITION_CLOSE` and
   `OPTION_EXPIRY`.** The SDK's `ACTIVITY_SUBTYPES` constants (`OPTION_OPEN`,
   `OPTION_CLOSE`, …) are a *different vocabulary* and match nothing — compare
   against the canonical strings, as `src/lib/wheel.ts` does.
2. **`ActivityDetails` carries `instrumentType` and `assetContractMultiplier`
   on the wire** even though the published TypeScript interface omits them.
   That is what lets this addon identify option contracts without an
   `assets.getProfile` round trip per contract (and one fewer permission).
3. **`OPTION_EXPIRY` does not mean the option expired worthless.** It is also
   what an assignment looks like. The only reliable tell is the share movement
   on the same day in the same account — see `matchAssignments` in
   `src/lib/wheel.ts`.

Activities added through the MCP tools cannot carry a subtype at all, so the
engine falls back to inferring intent from open interest: a trade on the
opposite side of an existing position closes it, anything else opens one.

## Develop

```bash
npm install
npm run dev              # rebuild on change
```

Then run the host with addon dev mode on, from the Wealthfolio repo:

```bash
VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev
```

## Test

Both engines are pure — no host dependencies — so their tests run standalone:

```bash
npx vitest run --config vitest.config.ts
```

The fixtures walk through complete wheel scenarios — a put assigned after 35
days, a covered call bought back for a gain, a 10-contract put roll, a cycle
called away below its basis — with every expected value worked out by hand
rather than read back from the engine, so a change to the money math fails a
test instead of quietly shifting a number.

## Package

```bash
npm run bundle           # -> dist/wealthfolio-wheel-tracker-addon-1.1.0.zip
```

The packager is dependency-free and writes the archive directly, because the
host is strict about two things: forward-slash paths (backslashes, which
PowerShell's `Compress-Archive` emits, are rejected as unsafe) and the
manifest's `main` actually existing in the archive. Zipping the project folder
does not work — the host caps an addon at 256 entries and 25 MB uncompressed.

## Version note

`sdkVersion` targets **3.8.0**. Compatibility is "same major, addon minor ≤ host
minor", so this installs on a 3.8 or 3.9 host. Targeting 3.9.0 would be rejected
by a 3.8 host.
