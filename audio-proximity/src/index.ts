import { randomBytes } from "crypto";
import express, { raw } from "express";
import { WebSocket } from "ws";
import expressWs from "express-ws";
import { readFileSync, writeFileSync } from "fs";

// Core types for our audio processing
interface AudioChunkType {
    timestamp: number;
    v: number;
    hash: string;
    type: "small" | "large" | "mid";
    features: {
        mfcc: number[];
        chroma: number[];
        rms: number;
        zcr: number;
        energy: number;
        spectralFlatness: number;
        spectralCentroid: number;
        perceptualSpread: number;
    };
}

// Config constants
const MONITOR_ONLY = true;
const RESEARCH_SAMPLE_DUR_SEC = 10;
const MAX_MFCC_FRAMES = 256;
const MIN_MFCC_FRAMES = 76;
const PORT = 7733;
const WINDOW_MS = 3500;
const NEAR_THRESHOLD = 0.72;
const DISPLAY_THRESHOLD = 0.6;
const RMS_THRESHOLD = 0.0008;
const VARIANCE_THRESHOLD = 0.015;

// Version control for client/server compatibility
let CONF_VER = 2;

// Setup express with websockets
const srv = express();
const app = expressWs(srv).app;

// Serve static demo page
app.get("/", (_, res) => {
    const page = readFileSync("./static/demo.html").toString();
    res.send(page);
});

// API endpoints for configuration values
app.get("/v", (_, res) => {
    res.status(200).send(CONF_VER);
});

app.get("/gain", (_, res) => {
    res.status(200).send(testCaseGain);
});

/**
 * Aligns two series of audio frames by their timestamps
 * This lets us compare frames that were captured at approximately the same time
 */
function alignByTimestamp(
    framesA: AudioChunkType[],
    framesB: AudioChunkType[],
    maxOffsetMs = 50
) {
    type FrameItem = {
        mfcc: number[];
        zcr: number;
        energy: number;
        spectralFlatness: number;
        spectralCentroid: number;
        perceptualSpread: number;
        ts: number;
    };

    const alignedA: FrameItem[] = [];
    const alignedB: FrameItem[] = [];

    let j = 0;

    for (let i = 0; i < framesA.length; i++) {
        const tA = framesA[i].timestamp;

        // Advance pointer in B until we find a timestamp close to A
        while (j < framesB.length && framesB[j].timestamp < tA - maxOffsetMs) {
            j++;
        }

        if (j >= framesB.length) break;

        const tB = framesB[j].timestamp;
        
        // If timestamps are close enough, add both frames to our alignment
        if (Math.abs(tA - tB) <= maxOffsetMs) {
            const a = framesA[i];
            const b = framesB[j];
            
            alignedA.push({
                mfcc: a.features.mfcc,
                zcr: a.features.zcr,
                energy: a.features.energy,
                spectralFlatness: a.features.spectralFlatness,
                spectralCentroid: a.features.spectralCentroid,
                perceptualSpread: a.features.perceptualSpread,
                ts: a.timestamp
            });
            
            alignedB.push({
                mfcc: b.features.mfcc,
                zcr: b.features.zcr,
                energy: b.features.energy,
                spectralFlatness: b.features.spectralFlatness,
                spectralCentroid: b.features.spectralCentroid,
                perceptualSpread: b.features.perceptualSpread,
                ts: b.timestamp
            });
            
            j++;
        }
    }

    return [alignedA, alignedB];
}

/**
 * Normalizes an array to have mean 0 and standard deviation 1
 */
function normalizeArray(arr: number[]): number[] {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    const std = Math.sqrt(variance) || 1; // Prevent division by zero
    return arr.map(x => (x - mean) / std);
}

/**
 * Computes delta (first derivative) coefficients from MFCC frames
 * Important for capturing dynamics in audio features
 */
function computeDelta(mfccSeq: number[][]): number[][] {
    const deltaSeq: number[][] = [];
    const N = 2; // Window size for delta calculation

    for (let t = 0; t < mfccSeq.length; t++) {
        const deltaFrame: number[] = [];
        
        for (let k = 0; k < mfccSeq[0].length; k++) {
            let numerator = 0;
            let denominator = 0;
            
            for (let n = 1; n <= N; n++) {
                const prevIndex = Math.max(t - n, 0);
                const nextIndex = Math.min(t + n, mfccSeq.length - 1);
                numerator += n * (mfccSeq[nextIndex][k] - mfccSeq[prevIndex][k]);
                denominator += 2 * n * n;
            }
            
            deltaFrame.push(numerator / denominator);
        }
        
        deltaSeq.push(deltaFrame);
    }
    
    return deltaSeq;
}

/**
 * Computes delta-delta (acceleration) coefficients
 */
function computeDeltaDelta(mfccSeq: number[][]): number[][] {
    const delta = computeDelta(mfccSeq);
    return computeDelta(delta);
}

// Feature weighting - more emphasis on lower coefficients
const baseWeights = Array.from({ length: 26 }, (_, i) => Math.exp(-0.2 * i));
const deltaWeights = baseWeights.map(w => w * 0.5);
const deltaDeltaWeights = baseWeights.map(w => w * 0.25);
const mfccWeights = [...baseWeights, ...deltaWeights, ...deltaDeltaWeights];

/**
 * Calculates cosine distance between two vectors
 * Better than Euclidean for high-dimensional feature vectors
 */
function cosineDistance(a: number[], b: number[]): number {
    const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
    const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
    
    if (normA === 0 || normB === 0) return 1;

    const cosineSim = dot / (normA * normB);
    const rawDistance = Math.max(0, 1 - cosineSim);

    // Non-linear scaling to emphasize differences
    return Math.min(1, Math.pow(rawDistance, 1.75));
}

/**
 * Apply exponential time decay to a feature sequence
 * Gives more weight to recent frames and less to older ones
 */
function calculateTimeDecayWeights(seqLength: number, decayFactor = 0.1): number[] {
    // Generate weights with exponential decay
    // Most recent frame (at the end) gets weight 1.0
    // Older frames get exponentially smaller weights
    const weights = [];
    for (let i = 0; i < seqLength; i++) {
        // Position from 0 (oldest) to 1 (newest)
        const position = i / (seqLength - 1 || 1); // Avoid division by zero
        // Exponential decay formula: e^(-decay * (1-position))
        // This gives weight=1.0 for newest item, and smaller weights for older items
        const weight = Math.exp(-decayFactor * (1 - position));
        weights.push(weight);
    }
    return weights;
}

/**
 * Apply time decay weights when computing DTW or other distance metrics
 */
function computeDTWWithTimeDecay(seqA: number[][], seqB: number[][], decayFactor = 0.15): number {
    const n = seqA.length;
    const m = seqB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
    dp[0][0] = 0;

    // Calculate decay weights for both sequences
    const weightsA = calculateTimeDecayWeights(n, decayFactor);
    const weightsB = calculateTimeDecayWeights(m, decayFactor);

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            // Base distance using cosine
            const baseCost = cosineDistance(seqA[i - 1], seqB[j - 1]);
            
            // Apply time-based weighting - average the weights from both sequences
            // This means frames that are recent in both sequences get highest priority
            const weightA = weightsA[i - 1];
            const weightB = weightsB[j - 1];
            
            const combinedWeight = (weightA + weightB) / 2;
            
            // Apply weight to the distance calculation - multiply by weight
            // to emphasize differences in more recent frames
            const cost = baseCost * combinedWeight;
            
            dp[i][j] = cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }

    // Normalize by path length to make it comparable between different length sequences
    return dp[n][m] / Math.min(n * 2, m * 2);
}

/**
 * Apply exponential moving average smoothing to similarity scores
 * Reduces jitter in the output
 */
function smoothSimilarity(prev: number | null, current: number, alpha = 0.2): number {
    if (prev === null) return current;
    return alpha * current + (1 - alpha) * prev;
}

/**
 * Normalize MFCCs per frame
 */
function normalizeMFCC(mfcc: number[]): number[] {
    return normalizeArray(mfcc);
}

/**
 * Create a unique key for each client pair
 */
function getPairKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * State tracking for client pairs and their similarity
 */
interface PairState {
    nearCount: number;
    farCount: number;
    isNear: boolean;
}

/**
 * Build a feature sequence combining multiple audio characteristics
 */
function buildCombinedFeatureSequence(buffer: any[]): number[][] {
    const mfccSeq = buffer.map(f => f.mfcc);
    const delta = computeDelta(mfccSeq);
    const deltaDelta = computeDeltaDelta(mfccSeq);

    // Extract and normalize additional features across time
    const extractAndNormalize = (key: keyof typeof buffer[0]) => {
        const arr = buffer.map(f => f[key] as number);
        return normalizeArray(arr);
    };

    const normZCR = extractAndNormalize("zcr");
    const normEnergy = extractAndNormalize("energy");
    const normFlatness = extractAndNormalize("spectralFlatness");
    const normCentroid = extractAndNormalize("spectralCentroid");
    const normSpread = extractAndNormalize("perceptualSpread");

    // Return the combined feature vectors
    return buffer.map((f, i) => [
        ...f.mfcc,
        ...delta[i],
        ...deltaDelta[i],
        normZCR[i],
        normEnergy[i],
        normFlatness[i],
        normCentroid[i],
        normSpread[i],
    ]);
}

/**
 * Calculate the average variance across all coefficients
 * Used to detect if audio has enough "information" to compare
 */
function averageVariance(seq: number[][]): number {
    if (seq.length === 0) return 0;
    
    const coeffCount = seq[0].length;

    // Input validation
    seq.forEach((row, idx) => {
        if (!Array.isArray(row)) {
            console.warn(`Row ${idx} is not an array`);
        } else if (row.length !== seq[0].length) {
            console.warn(`Row ${idx} length mismatch: expected ${seq[0].length}, got ${row.length}`);
        }
    });

    // Safe transpose with fallback to 0 for invalid entries
    const transposed: number[][] = Array.from({ length: coeffCount }, (_, colIdx) =>
        seq.map(row => {
            const val = row[colIdx];
            if (typeof val !== "number" || isNaN(val)) {
                console.warn(`Invalid value at row[${colIdx}]:`, val);
                return 0;
            }
            return val;
        })
    );

    // Calculate variance for each coefficient across time
    const variances = transposed.map(col => {
        const mean = col.reduce((a, b) => a + b, 0) / col.length;
        const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
        
        if (isNaN(variance)) {
            console.warn("Variance NaN for column:", col);
            return 0;
        }
        
        return variance;
    });

    if (variances.some(v => isNaN(v))) {
        console.warn("Variances contain NaN values", variances);
    }

    return variances.reduce((a, b) => a + b, 0) / variances.length;
}

let clientIdCounter = 0;
const clientMap = new Map<WebSocket, number>();
const idToSocketMap = new Map<number, WebSocket>();

const fvectBuffers: Record<number, {
    mfcc: number[];
    zcr: number;
    energy: number;
    spectralFlatness: number;
    spectralCentroid: number;
    perceptualSpread: number;
    ts: number;
}[]> = {};
const rmsBuffers: Record<number, number[]> = {};
const similaritySmoothers: Record<number, number | null> = {};
const similarityHistory: Record<string, { timestamp: number, near: boolean, sim: number }[]> = {};

// State tracking
// const rmsBuffers: number[][] = [];
// const fvectBuffers: {
//     mfcc: number[];
//     zcr: number;
//     energy: number;
//     spectralFlatness: number;
//     spectralCentroid: number;
//     perceptualSpread: number;
//     ts: number;
// }[][] = [];

// Research mode variables
let avg = 0;
let avgNum = 0;
let firstAvgDate: number | null = null;
let complete = false;
let eta = -1;
let testCaseGain = 1;

// Client management
let clients: { [key: number]: {
    name: string;
}} = {};
let results: { [key: number]: number } = {};
// let similaritySmoothers: { [key: number]: number | null } = {};

// History tracking for stabilizing near/far detection
// const similarityHistory: { [pairKey: string]: { timestamp: number; near: boolean; sim: number }[]; } = {};

/**
 * Broadcast a message to specified clients
 */
function broadcast(msg: string, clientIds: number[]) {
    clientIds.forEach(v => {
        const ws = idToSocketMap.get(v);

        if (ws && msg == "kick")
            return ws.close();

        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(msg);
    });
}

app.get("/public-data/name/:clientId", (req, res) => {
    const id = parseInt(req.params.clientId as string);

    if (isNaN(id)) {
        res.status(400).send("\"" + req.params.clientId + "\" is not a valid client id");

        return;
    }
    
    const c = clients[id];

    if (!c) {
        res.status(404).send("No client could be found with id matching \"" + req.params.clientId + "\"");

        return;
    }

    res.status(200).send(c.name);
});

// WebSocket endpoint for real-time audio processing
app.ws("/stream", (ws, req) => {
    const clientId = clientIdCounter++;

    clientMap.set(ws, clientId);
    idToSocketMap.set(clientId, ws);

    console.log(`Client ${clientId} connected`);

    let pmatches = "";

    let i = 0;

    // Handle incoming audio data
    ws.onmessage = (message) => {
        if (complete && message.data.toString() === "stop-ack") {
            ws.close();
            return;
        }
        
        if (complete) return;

        const str = message.data.toString();

        if (str === "INIT") {
            // Initialize buffers for this client
            fvectBuffers[clientId] = [];
            rmsBuffers[clientId] = [];
            similaritySmoothers[clientId] = null;

            // Store the send function for this client
            clients[clientId] = {
                name: "Unknown User " + randomBytes(4).toString("hex"),
            };

            ws.send("init-ack");

            return;
        }

        if (str.startsWith("NAME::")) {
            if (clients[clientId])
                clients[clientId].name = str.slice(6, str.length);

            return;
        }

        const data = JSON.parse(message.data.toString()) as AudioChunkType;

        // Verify version compatibility
        if (data.v !== CONF_VER) {
            console.warn("Rejected sample from client", clientId, "invalid config version", data.v, "expected", CONF_VER);
            ws.close();
            return;
        }

        if (i >= 10) {
            console.log(clientId, data);
            i = 0;
        }

        i++

        if (!rmsBuffers[clientId] || !fvectBuffers[clientId])
            return;

        // Normalize current MFCC frame
        const normMFCC = normalizeMFCC(data.features.mfcc);

        // Store RMS values
        rmsBuffers[clientId].push(data.features.rms);

        if (rmsBuffers[clientId].length > MAX_MFCC_FRAMES)
            rmsBuffers[clientId].shift();

        const buffer = fvectBuffers[clientId];

        // Store normalized features
        buffer.push({
            mfcc: normMFCC,
            zcr: data.features.zcr,
            energy: data.features.energy,
            spectralFlatness: data.features.spectralFlatness,
            spectralCentroid: data.features.spectralCentroid,
            perceptualSpread: data.features.perceptualSpread,
            ts: data.timestamp,
        });

        // Maintain limited buffer size
        if (buffer.length > MAX_MFCC_FRAMES)
            buffer.shift();

        // Only process when we have enough data
        if (buffer.length >= MIN_MFCC_FRAMES) {
            let comparisons: { [key: number]: number } = {};

            // Compare with all other clients
            for (const [otherWs, i] of clientMap.entries()) {
                if (i === clientId) continue;

                // const otherBuffer = buffer;
                const otherBuffer = fvectBuffers[i];

                if (otherBuffer.length < MIN_MFCC_FRAMES) continue;

                // Convert to required format for timestamp alignment
                const [a, b] = alignByTimestamp(buffer.map(v => {
                    const d: AudioChunkType = {
                        hash: "",
                        v: -1,
                        timestamp: v.ts,
                        type: "small",
                        features: {
                            zcr: v.zcr,
                            chroma: [],
                            mfcc: v.mfcc,
                            energy: v.energy,
                            perceptualSpread: v.perceptualSpread,
                            spectralCentroid: v.spectralCentroid,
                            spectralFlatness: v.spectralFlatness,
                            rms: 0,
                        },
                    };

                    return d;
                }), otherBuffer.map(v => {
                    const d: AudioChunkType = {
                        hash: "",
                        v: -1,
                        timestamp: v.ts,
                        type: "small",
                        features: {
                            zcr: v.zcr,
                            chroma: [],
                            mfcc: v.mfcc,
                            energy: v.energy,
                            perceptualSpread: v.perceptualSpread,
                            spectralCentroid: v.spectralCentroid,
                            spectralFlatness: v.spectralFlatness,
                            rms: 0,
                        },
                    };

                    return d;
                }));

                console.log("Aligned lengths:", a.length, b.length);

                console.clear();

                // Build full feature sequences with deltas and normalization
                const combinedSeq = buildCombinedFeatureSequence(a);
                const otherCombinedSeq = buildCombinedFeatureSequence(b);

                // Calculate DTW distance between sequences
                const dtwScore = computeDTWWithTimeDecay(combinedSeq, otherCombinedSeq);

                console.log("DTW score:", dtwScore);

                if (isNaN(dtwScore)) {
                    console.warn("DTW score is NaN!", { aLen: combinedSeq.length, bLen: otherCombinedSeq.length });
                }
                
                // Convert distance to similarity (exponential decay)
                let similarity = Math.exp(-dtwScore / 2);

                // Apply RMS-based weighting (for pair with rms thresh)
                const rmsA = data.features.rms;
                const rmsB = rmsBuffers[i]?.length ? rmsBuffers[i].reduce((a, b) => a + b, 0) / rmsBuffers[i].length : 0;

                const combinedRMS = Math.min(rmsA, rmsB);
                const rmsWeight = Math.min(1, Math.min(1, combinedRMS / RMS_THRESHOLD));

                similarity *= rmsWeight;

                // Low RMS = mostly silence, zero out similarity
                if (combinedRMS < RMS_THRESHOLD) {
                    similarity = 0;
                } else {
                    // Weight by RMS balance between clients - strongly promote similar energy levels
                    const rmsRatio = Math.min(rmsA, rmsB) / Math.max(rmsA, rmsB);
                    
                    const rmsWeightEnhanced = Math.pow(rmsRatio, 0.7);
                    
                    // Boost very similar RMS values (> 80% similar) with a bonus
                    const similarityBonus = rmsRatio > 0.8 ? 0.15 * ((rmsRatio - 0.8) / 0.2) : 0;
                    
                    // Final weight combines base sigmoid-like function with bonus
                    const rmsWeight = Math.min(1, 0.2 + 0.8 * rmsWeightEnhanced + similarityBonus);
                    
                    similarity *= rmsWeight;
                }

                // Apply variance penalty - low variance = not enough information
                const varA = averageVariance(combinedSeq);
                const varB = averageVariance(otherCombinedSeq);
                
                const lowVariancePenalty = Math.min(1, Math.min(varA, varB) / VARIANCE_THRESHOLD);

                console.log("LVP:", lowVariancePenalty)

                similarity *= lowVariancePenalty;

                // Smooth similarity over time
                similaritySmoothers[clientId] = smoothSimilarity(similaritySmoothers[clientId], similarity, 0.25);
                const smoothedSim = similaritySmoothers[clientId]!;

                // Determine near/far state
                const isNear = (smoothedSim >= NEAR_THRESHOLD);
                const pairKey = getPairKey(clientId, i);

                // Initialize history for this pair if needed
                if (!similarityHistory[pairKey]) {
                    similarityHistory[pairKey] = [];
                }

                const now = Date.now();

                // Add current state to history
                similarityHistory[pairKey].push({ timestamp: now, near: isNear, sim: smoothedSim });

                // Remove old history beyond WINDOW_MS
                similarityHistory[pairKey] = similarityHistory[pairKey].filter(
                    entry => now - entry.timestamp <= WINDOW_MS
                );

                // Count near vs total states
                const nearCount = similarityHistory[pairKey].filter(e => e.near).length;
                const totalCount = similarityHistory[pairKey].length;

                // Calculate average similarity over the window
                const smartSim = (similarityHistory[pairKey].reduce((prev, curr) => {
                    return prev + curr.sim;
                }, 0) / similarityHistory[pairKey].length);

                console.log(smartSim);

                // Decide display state by ratio of near states
                const displayNear = totalCount > 0 && (nearCount / totalCount) >= DISPLAY_THRESHOLD;

                comparisons[i] = displayNear ? Math.max(NEAR_THRESHOLD, parseFloat(smartSim.toFixed(2))) : 0;

                // In research mode, accumulate data
                if (!MONITOR_ONLY) {
                    avg += smoothedSim;
                    avgNum++;
                }

                // Track research start time
                if (!(firstAvgDate && MONITOR_ONLY))
                    firstAvgDate = Date.now();

                const localEta = RESEARCH_SAMPLE_DUR_SEC - Math.floor((Date.now() - firstAvgDate) / 1000);

                // Skip updates if ETA hasn't changed
                if (!MONITOR_ONLY && localEta === eta) return;
                
                if (!MONITOR_ONLY) console.clear();
                if (!MONITOR_ONLY) console.log("Sampling started at", new Date(firstAvgDate).toISOString());
                eta = localEta;

                // Research sample completion
                if (!MONITOR_ONLY && Date.now() - firstAvgDate > RESEARCH_SAMPLE_DUR_SEC * 1000) {
                    const avgSim = avg / avgNum;
                    console.log("Sampling completed, average similarity:", avgSim);

                    results[testCaseGain] = avgSim;
                    complete = true;

                    // Stop clients
                    setTimeout(() => {
                        broadcast("stop", [clientId, i]);
                    }, 0);

                    // Cleanup and prepare for next test case
                    setTimeout(() => {
                        broadcast("kick", [clientId, i]);
                        avg = 0;
                        avgNum = 0;
                        firstAvgDate = null;
                        complete = false;
                        eta = -1;
                        testCaseGain++;
                        CONF_VER++;

                        // Research complete after 10 gain levels
                        if (testCaseGain > 10) {
                            console.clear();
                            console.log("Research complete ------------------------------");
                            let bestResult = { gain: -1, sim: -1 };
                            
                            Object.keys(results).forEach(k => {
                                const r = results[parseInt(k)];
                                console.log(`Gain: ${k}, Avg Sim: ${r}`);
                                if (r > bestResult.sim) bestResult = { gain: parseInt(k), sim: r };
                            });
                            
                            console.log(`\nBest result was with Gain == ${bestResult.gain} (avg similarity == ${bestResult.sim})`);
                        }
                    }, 250);
                } else if (!MONITOR_ONLY) {
                    console.log(`Research sample time remaining: ${localEta} second${localEta === 1 ? "" : "s"}`);
                }
            }

            // In monitor mode, display client similarities
            if (MONITOR_ONLY) {
                Object.entries(comparisons).forEach(([k, v]) => {
                    console.log(`Client ${clientId} <--> Client ${k}, Similarity: ${v}`);
                });

                const matches = Object.keys(comparisons).filter(v => comparisons[parseInt(v)] >= NEAR_THRESHOLD);
                console.log("Nearby:", [...matches, ...(matches.length > 0 ? [clientId.toString()] : [])].sort());

                const newmatches = matches.sort().join(",");

                if (newmatches !== pmatches) {
                    pmatches = newmatches;
                    
                    ws.send(`PROX:${pmatches}`);
                }
            }
        }

        // Acknowledge receipt
        ws.send("ack");
    };

    // Handle client disconnection
    ws.onclose = () => {
        console.log(`Client ${clientId} disconnected`);

        clientMap.delete(ws);
        idToSocketMap.delete(clientId);

        delete fvectBuffers[clientId];
        delete rmsBuffers[clientId];
        delete similaritySmoothers[clientId];

        // Remove all similarity history involving this client
        for (const key in similarityHistory) {
            if (key.includes(`${clientId}`)) {
                delete similarityHistory[key];
            }
        }
    };
});

// Start server
app.listen(PORT, () => {
    console.log(`Server active at http://localhost:${PORT}`);
});