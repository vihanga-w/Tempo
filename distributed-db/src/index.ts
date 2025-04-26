import express from "express";
import bodyParser from "body-parser";
import { Enc } from "./enc-utils";
import { createHash } from "crypto";
import { DataStore } from "./db";

export interface DDBQuery {
    type: "get" | "set" | "update" | "query" | "ping" | "exists" | "remove" | "all";
    collection: string;
    path: string;
    value: any;
    notNull?: boolean;
    signature: string;
    timestamp: number;
    isObject?: boolean;
}

console.log("Starting Tempo database server");

const ds = new DataStore();
const enc = new Enc();
const app = express();

app.use(bodyParser.json());

<<<<<<< HEAD
// const cluster = new ClusterManager({
//     id: process.env.NODE_ID!,
//     peers: JSON.parse(process.env.PEERS!),
//     raftPort: 5000,
//     app,
//     datastore: ds,
// });

app.post("/query", async (req, res) => {
    // if (!cluster.isLeader()) {
    //     res.status(403).send("This node is not the leader");
    //     return;
    // }

=======
app.post("/query", async (req, res) => {
>>>>>>> parent of 7816dc4 (Upadate db)
    const data = req.body as DDBQuery;

    const timestampOffset = Math.abs(Date.now() - data.timestamp);

    if (timestampOffset > 5e3) {
        res.status(400).send("Datetime mismatch");
        return;
    }

    const valid = await enc.verifySignedData(data, data.signature);

    if (!valid) {
        res.status(403).send("Forbidden");

        return;
    }

    try {
        if (data.type == "get") {
            const q = await ds.get(data.collection, data.path, data.notNull);

            res.status(200).json({
                data: (q && data.isObject && typeof q == "string" ? JSON.parse(q) : q)
            });
        } else if (data.type == "set") {
            await ds.set(data.collection, data.path, (data.isObject ? data.value as {} : data.value as string));

            res.status(200).send("OK");
        } else if (data.type == "update") {
            await ds.update(data.collection, data.path, (data.isObject ? data.value as {} : data.value as string));

            res.status(200).send("OK");
        } else if (data.type == "remove") {
            await ds.remove(data.collection, data.path);

            res.status(200).send("OK");
        } else if (data.type == "exists") {
            const exists = await ds.exists(data.collection, data.path);

            res.status(200).json({
                exists,
            });
        } else if (data.type == "query") {
            // Not yet handled
        } else if (data.type == "ping") {
            res.status(200).send("pong");
        } else if (data.type == "all") {
            const items = ds.ref(data.collection);

            let itemObjs: any[] = [];

            await items.forEach(async v => {
                itemObjs.push(v.val());
            });

            res.status(200).json({
                data: itemObjs,
            });
        }

        // if (data.type === "set" || data.type === "update" || data.type === "remove") {
        //     await cluster.replicateCommand({
        //         type: data.type,
        //         collectionId: data.collection,
        //         path: data.path,
        //         value: data.value,
        //     });
        // }        
    } catch (ex: any) {
        console.error("Query failed with error, query:", data, "error:", ex);

        res.status(500).send(ex.toString());
    }
});

ds.on("ready", () => {
<<<<<<< HEAD
    app.listen(2276, () => {
        console.log("Tempo database server running on port", 2276);
=======
    app.listen(2275, () => {
        console.log("Tempo database server running on port", 2275);
>>>>>>> parent of 7816dc4 (Upadate db)
    });
});