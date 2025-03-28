const SENSITIVITY = 100;

function normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
    return vector.map(val => val / norm);
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
    }
    return dotProduct;
}

function euclideanDistance(vecA: number[], vecB: number[]): number {
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
        sum += Math.pow(vecA[i] - vecB[i], 2);
    }
    return Math.sqrt(sum);
}

function manhattanDistance(vecA: number[], vecB: number[]): number {
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
        sum += Math.abs(vecA[i] - vecB[i]);
    }
    return sum;
}

export function combinedSimilarity(vecA: number[], vecB: number[]): number {
    vecA = normalize(vecA);
    vecB = normalize(vecB);

    const cosineSim = cosineSimilarity(vecA, vecB);
    const euclideanDist = euclideanDistance(vecA, vecB);
    const manhattanDist = manhattanDistance(vecA, vecB);

    return cosineSim / (1 + SENSITIVITY * (euclideanDist + manhattanDist));
}