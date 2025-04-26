import express from "express";
import { RaftNode, RequestVoteArgs, AppendEntriesArgs } from "../raft/raft-node";
import { Enc } from "../enc-utils";
import { DataStore } from "../db";

interface ClusterOptions {
    id: string;
    peers: { id: string; address: string }[];
    raftPort: number;
    app: express.Express;
    datastore: DataStore;
}

export class ClusterManager {
    private raftNode: RaftNode;
    private enc: Enc;

    constructor(options: ClusterOptions) {
        this.enc = new Enc("raft");
        this.raftNode = new RaftNode(options.id, options.peers, this.enc, options.datastore);

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
        
            const isValid = await this.enc.verifyRaftMessage(data.entries, signature);
        
            if (!isValid) {
                console.warn("Rejected invalid signed appendEntries");

                res.status(403).send("Invalid signature");
                return;
            }
        
            const result = this.raftNode.handleAppendEntries(data);
            res.status(200).json(result);
        });        
    }

    public async replicateCommand(command: { type: "set" | "update" | "remove"; collectionId: string; path: string; value?: any; }) {
        const entry = {
            index: this.raftNode.getNextLogIndex(),
            term: this.raftNode.getCurrentTerm(),
            command,
        };
    
        this.raftNode.appendEntry(entry);
    
        await this.raftNode.replicateEntries([entry]);
    }
    
    public getLeaderId(): string | null {
        return this.raftNode.getLeader();
    }

    public isLeader(): boolean {
        return this.raftNode.getState() === "Leader";
    }
}