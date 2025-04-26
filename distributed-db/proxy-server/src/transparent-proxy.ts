import net from "net";
import axios from "axios";

interface ProxyOptions {
    listenPort: number;
    leaderDiscoveryUrl: string; // e.g., http://tempo-node-1:2275/raft/leader
    refreshIntervalMs?: number;
}

export class TransparentProxy {
    private listenPort: number;
    private leaderDiscoveryUrl: string;
    private server: net.Server;
    private leaderAddress: string | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;
    private refreshIntervalMs: number;

    constructor(options: ProxyOptions) {
        this.listenPort = options.listenPort;
        this.leaderDiscoveryUrl = options.leaderDiscoveryUrl;
        this.refreshIntervalMs = options.refreshIntervalMs ?? 2000; // Default 2 seconds

        this.server = net.createServer(this.handleClient.bind(this));
    }

    public start() {
        this.server.listen(this.listenPort, () => {
            console.log(`[Proxy] Listening on port ${this.listenPort}`);
        });

        this.startLeaderRefresh();
    }

    private startLeaderRefresh() {
        this.refreshTimer = setInterval(async () => {
            try {
                const response = await axios.get<{ leaderAddress: string }>(this.leaderDiscoveryUrl);
                if (response.data.leaderAddress !== this.leaderAddress) {
                    console.log(`[Proxy] Leader updated to ${response.data.leaderAddress}`);
                }
                this.leaderAddress = response.data.leaderAddress;
            } catch (err) {
                console.warn("[Proxy] Failed to refresh leader info:", err);
            }
        }, this.refreshIntervalMs);
    }

    private async handleClient(clientSocket: net.Socket) {
        if (!this.leaderAddress) {
            console.error("[Proxy] No leader available, rejecting client connection");
            clientSocket.destroy();
            return;
        }

        try {
            console.log(`[Proxy] Forwarding client to leader at ${this.leaderAddress}`);

            const [host, portStr] = this.leaderAddress.split(":");
            const port = parseInt(portStr, 10);

            const leaderSocket = net.connect(port, host);

            clientSocket.pipe(leaderSocket);
            leaderSocket.pipe(clientSocket);

            leaderSocket.on("error", (err) => {
                console.error("[Proxy] Leader connection error:", err.message);
                clientSocket.destroy();
            });

            clientSocket.on("error", (err) => {
                console.error("[Proxy] Client connection error:", err.message);
                leaderSocket.destroy();
            });

        } catch (err) {
            console.error("[Proxy] Failed to forward client:", err);
            clientSocket.destroy();
        }
    }

    public stop() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.server.close();
    }
}