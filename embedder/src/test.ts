import { readFileSync } from "fs";
import { EmbeddingOutput } from "./autoencoder";

// const s1 = JSON.parse(readFileSync("./embeddings/b9762909-720b-4a6f-9f1a-053cd7ea24cb_embedding.json", "utf8")) as EmbeddingOutput;
// const s2 = JSON.parse(readFileSync("./embeddings/52ad4fee-1f4e-4f0d-ab24-cc2691517d93_embedding.json", "utf8")) as EmbeddingOutput;

const s1 = JSON.parse(readFileSync("./embeddings/b3b6b3d5-4c0e-481a-b849-e4afda2d72c7_embedding.json", "utf8")) as EmbeddingOutput;
const s2 = JSON.parse(readFileSync("./embeddings/b327b4cc-f5ef-420c-994f-cdc25a55592d_embedding.json", "utf8")) as EmbeddingOutput;

function normalize(vector: number[]): number[] {
	const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
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

function combinedSimilarity(vecA: number[], vecB: number[]): number {
	vecA = normalize(vecA);
	vecB = normalize(vecB);

	const cosineSim = cosineSimilarity(vecA, vecB);
	const euclideanDist = euclideanDistance(vecA, vecB);
	const manhattanDist = manhattanDistance(vecA, vecB);

	return cosineSim / (1 + euclideanDist + manhattanDist);
}

const similarity = combinedSimilarity(s1.embedding, s2.embedding);
console.log("Combined similarity:", similarity);