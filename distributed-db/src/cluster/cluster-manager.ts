import express from "express";
import { RaftNode, RequestVoteArgs, AppendEntriesArgs } from "../raft/raft-node";
import { Enc } from "../enc-utils";

interface ClusterOptions {
    id: string;
    peers: { id: string; address: string }[];
    raftPort: number;
    app: express.Express;
}

export class ClusterManager {
    private raftNode: RaftNode;
    private enc: Enc;

    constructor(options: ClusterOptions) {
        this.enc = new Enc("raft");
        this.raftNode = new RaftNode(options.id, options.peers, this.enc);

        this.setupRaftApi(options.app);
    }

    private setupRaftApi(app: express.Express) {
        app.get("/raft/leader", (_, res) => {
            if (!this.raftNode.getLeader()) {
                res.status(503).send("No leader yet");

                return;
            }
        
            res.status(200).json({
                leaderAddress: this.raftNode.getLeader()!
            });
        });

        app.post("/raft/requestVote", async (req, res) => {
            const { data, signature } = req.body;
        
            const isValid = await this.enc.verifyRaftMessage(data, signature);
        
            if (!isValid) {
                console.warn("Rejected invalid signed vote request");

                res.status(403).send("Invalid signature");
                return;
            }
        
            const result = this.raftNode.handleRequestVote(data);
            res.status(200).json(result);
        });

        app.post("/raft/appendEntries", async (req, res) => {
            const { data, signature } = req.body;
        
            const isValid = await this.enc.verifyRaftMessage(data, signature);
        
            if (!isValid) {
                console.warn("Rejected invalid signed appendEntries");

                res.status(403).send("Invalid signature");
                return;
            }
        
            const result = this.raftNode.handleAppendEntries(data);
            res.status(200).json(result);
        });        
    }

    public getLeaderId(): string | null {
        return this.raftNode.getLeader();
    }

    public isLeader(): boolean {
        return this.raftNode.getState() === "Leader";
    }
}