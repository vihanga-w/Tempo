import { TransparentProxy } from "./transparent-proxy";

const proxy = new TransparentProxy({
    listenPort: 2276,
    leaderDiscoveryUrl: process.env.LEADER_DISCOVERY_URL!,
    refreshIntervalMs: 5000,
});

proxy.start();