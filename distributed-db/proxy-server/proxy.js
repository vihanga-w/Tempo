const { TransparentProxy } = require("../build/src/proxy/transparent-proxy");

const proxy = new TransparentProxy({
    listenPort: 2276,
    leaderDiscoveryUrl: process.env.LEADER_DISCOVERY_URL,
    refreshIntervalMs: 5e3,
});

proxy.start();
