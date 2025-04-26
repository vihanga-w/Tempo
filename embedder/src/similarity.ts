const SENSITIVITY = 0;

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

function manhattanDistance(vecA: number[], vecB: number[]): number {
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
        sum += Math.abs(vecA[i] - vecB[i]);
    }
    return sum;
}

export function combinedSimilarity(vecA: number[], vecB: number[], sensitivity?: number): number {
    vecA = normalize(vecA);
    vecB = normalize(vecB);

    const cosineSim = cosineSimilarity(vecA, vecB);
    const euclideanDist = euclideanDistance(vecA, vecB);
    const manhattanDist = manhattanDistance(vecA, vecB);

    return cosineSim / (1 + (sensitivity ?? SENSITIVITY) * (euclideanDist + manhattanDist));
}

/**
 * Calculates the Euclidean distance between two vectors.
 * @param vecA First vector
 * @param vecB Second vector
 * @returns Distance
 */
export function euclideanDistance(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
        throw new Error('Vectors must be of the same length');
    }
    
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
        const diff = vecA[i] - vecB[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}