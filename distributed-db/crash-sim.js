const axios = require("axios");
const { exec } = require("child_process");

const PROXY_URL = "http://localhost:2275/query"; // Proxy listens on 2275
const NODES = ["node1", "node2", "node3"];
const SLEEP_MS = 3000;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendQuery(i) {
    try {
        const body = {
            type: "set",
            collection: "users",
            path: `user${i}`,
            value: { name: `User ${i}` },
            timestamp: Date.now(),
            signature: "test-sig", // skipping real signature for test
            isObject: true
        };

        const res = await axios.post(PROXY_URL, body);
        console.log(`[Query ${i}] Status: ${res.status}`);
    } catch (err) {
        console.error(`[Query ${i}] Failed:`, err.response?.status || err.message);
    }
}

async function killRandomNode() {
    const randomNode = NODES[Math.floor(Math.random() * NODES.length)];
    console.log(`💀 Killing ${randomNode}...`);

    return new Promise((resolve, reject) => {
        exec(`docker-compose stop ${randomNode}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to kill ${randomNode}:`, error.message);
                return reject(error);
            }
            console.log(`✔️ ${randomNode} stopped`);
            resolve();
        });
    });
}

async function restartNode(node) {
    console.log(`🔁 Restarting ${node}...`);

    return new Promise((resolve, reject) => {
        exec(`docker-compose start ${node}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to restart ${node}:`, error.message);
                return reject(error);
            }
            console.log(`✔️ ${node} restarted`);
            resolve();
        });
    });
}

async function main() {
    console.log("🚀 Starting cluster test...");

    let i = 0;

    while (true) {
        await sendQuery(i);
        i++;

        if (i % 5 === 0) {
            await killRandomNode();
            await sleep(5000); // Give Raft time to elect new leader
            await restartNode(NODES[Math.floor(Math.random() * NODES.length)]);
            await sleep(5000);
        }

        await sleep(SLEEP_MS);
    }
}

main().catch(err => {
    console.error("Test crashed:", err.message);
});
