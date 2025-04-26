import axios from "axios";
import { Enc } from "../enc-utils";
import { DataStore } from "../db";

export type NodeRole = "Follower" | "Candidate" | "Leader";

interface PeerInfo {
    id: string;
    address: string; // ip:port
}

export interface LogEntry {
    index: number;
    term: number;
    command: {
        type: "set" | "update" | "remove";
        collectionId: string;
        path: string;
        value?: any;
    };
}

export interface RequestVoteArgs {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
}

interface RequestVoteReply {
    term: number;
    voteGranted: boolean;
}

export interface AppendEntriesArgs {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: any[];
    leaderCommit: number;
}

interface AppendEntriesReply {
    term: number;
    success: boolean;
}

export class RaftNode {
    private id: string;
    private peers: PeerInfo[];
    private state: NodeRole = "Follower";
    private currentTerm: number = 0;
    private votedFor: string | null = null;
    private log: any[] = [];
    private commitIndex: number = 0;
    private lastApplied: number = 0;
    private electionTimeout: NodeJS.Timeout | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private leaderId: string | null = null;
    private enc: Enc;
    private datastore: DataStore; 

    constructor(id: string, peers: PeerInfo[], enc: Enc, datastore: DataStore) {
        this.datastore = datastore;
        this.id = id;
        this.peers = peers;
        this.enc = enc;

        this.resetElectionTimer();
    }

    private resetElectionTimer() {
        if (this.electionTimeout) clearTimeout(this.electionTimeout);

        const timeout = 150 + Math.random() * 150;

        this.electionTimeout = setTimeout(() => {
            console.log(`[${this.id}] Election timeout, starting election`);
            this.startElection();
        }, timeout);
    }

    public appendEntry(entry: LogEntry) {
        this.log.push(entry);
    }
    
    public getNextLogIndex(): number {
        return this.log.length;
    }
    
    public getCurrentTerm(): number {
        return this.currentTerm;
    }
    
    public async replicateEntries(entries: LogEntry[]) {
        const promises = this.peers.map(async (peer) => {
            try {
                await axios.post(`http://${peer.address}/raft/appendEntries`, {
                    data: {
                        term: this.currentTerm,
                        leaderId: this.id,
                        prevLogIndex: this.log.length - entries.length - 1,
                        prevLogTerm: this.getLastLogTerm(),
                        entries,
                        leaderCommit: this.commitIndex,
                    },
                    signature: this.enc.signRaftMessage(entries),
                });
            } catch (ex) {
                console.warn(`[${this.id}] Failed to replicate entries to ${peer.id}`);
            }
        });
    
        await Promise.all(promises);
    }    

    private async startElection() {
        this.state = "Candidate";
        this.currentTerm += 1;
        this.votedFor = this.id;
        let votesGranted = 1;

        this.resetElectionTimer();

        const voteData = {
            term: this.currentTerm,
            candidateId: this.id,
            lastLogIndex: this.log.length - 1,
            lastLogTerm: this.getLastLogTerm(),
        };

        const signature = this.enc.signRaftMessage(voteData);

        for (const peer of this.peers) {
            try {
                const response = await axios.post<RequestVoteReply>(`http://${peer.address}/raft/requestVote`, {
                    data: voteData,
                    signature
                });

                if (response.data.voteGranted) {
                    votesGranted += 1;
                    if (votesGranted > Math.floor((this.peers.length + 1) / 2)) {
                        console.log(`[${this.id}] Won election, becoming Leader`);
                        this.becomeLeader();
                        return;
                    }
                } else if (response.data.term > this.currentTerm) {
                    console.log(`[${this.id}] Higher term detected, becoming Follower`);
                    this.currentTerm = response.data.term;
                    this.state = "Follower";
                    this.votedFor = null;
                    this.resetElectionTimer();
                    return;
                }
            } catch (err: any) {
                console.warn(`[${this.id}] Vote request to ${peer.id} failed`, err.message);
            }
        }
    }

    private becomeLeader() {
        this.state = "Leader";
        this.leaderId = this.id;
        if (this.electionTimeout) clearTimeout(this.electionTimeout);

        this.startHeartbeat();
    }

    private startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeats();
        }, 100);
    }

    private async sendHeartbeats() {
        const heartbeatData = {
            term: this.currentTerm,
            leaderId: this.id,
            prevLogIndex: this.log.length - 1,
            prevLogTerm: this.getLastLogTerm(),
            entries: [],
            leaderCommit: this.commitIndex,
        };

        const signature = this.enc.signRaftMessage(heartbeatData);

        for (const peer of this.peers) {
            try {
                await axios.post<AppendEntriesReply>(`http://${peer.address}/raft/appendEntries`, {
                    data: heartbeatData,
                    signature
                });
            } catch (err) {
                console.warn(`[${this.id}] Heartbeat failed to ${peer.id}`, err);
            }
        }
    }

    public handleRequestVote(args: RequestVoteArgs): RequestVoteReply {
        if (args.term < this.currentTerm) {
            return { term: this.currentTerm, voteGranted: false };
        }

        if ((this.votedFor === null || this.votedFor === args.candidateId) && this.isLogUpToDate(args.lastLogIndex, args.lastLogTerm)) {
            this.votedFor = args.candidateId;
            this.currentTerm = args.term;
            this.resetElectionTimer();
            return { term: this.currentTerm, voteGranted: true };
        } else {
            return { term: this.currentTerm, voteGranted: false };
        }
    }

    public handleAppendEntries(args: AppendEntriesArgs): AppendEntriesReply {
        if (args.term < this.currentTerm) {
            return { term: this.currentTerm, success: false };
        }
    
        this.leaderId = args.leaderId;
        this.currentTerm = args.term;
        this.state = "Follower";
        this.resetElectionTimer();
    
        if (args.entries.length > 0) {
            for (const entry of args.entries) {
                this.applyLogEntry(entry);
            }
        }
    
        return { term: this.currentTerm, success: true };
    }

    private async applyLogEntry(entry: LogEntry) {
        const command = entry.command;
    
        if (command.type === "set") {
            await this.datastore.set(command.collectionId, command.path, command.value);
        } else if (command.type === "update") {
            await this.datastore.update(command.collectionId, command.path, command.value);
        } else if (command.type === "remove") {
            await this.datastore.remove(command.collectionId, command.path);
        }
    }    

    private getLastLogTerm(): number {
        if (this.log.length === 0) return 0;
        return this.log[this.log.length - 1].term;
    }

    private isLogUpToDate(lastLogIndex: number, lastLogTerm: number): boolean {
        const lastTerm = this.getLastLogTerm();
        if (lastLogTerm !== lastTerm) {
            return lastLogTerm > lastTerm;
        } else {
            return lastLogIndex >= this.log.length - 1;
        }
    }

    public getState(): NodeRole {
        return this.state;
    }

    public getLeader(): string | null {
        return this.leaderId;
    }
}