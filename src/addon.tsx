import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { WheelPage } from './pages/WheelPage';

// The host owns a single React root per addon and mounts the route `component`
// itself (`createElement(Component, { location })`) with no access to the addon
// context. Capture it at enable time so the route wrapper can hand it down.
// (Do NOT call createRoot yourself — the host manages the lifecycle.)
let addonCtx: AddonContext | undefined;

// The route id MUST match `contributes.routes[].id` in manifest.json, and the
// host derives the path from the manifest addon id.
const ADDON_ID = 'wheel-tracker';

const WheelRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <WheelPage ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  ctx.router.add({
    id: ADDON_ID,
    path: `/addons/${ADDON_ID}`,
    component: WheelRoute,
  });

  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};

export default enable;
