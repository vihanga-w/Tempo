import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { basename, extname, join } from 'path';
import { decode } from 'node-wav';
import Meyda from 'meyda';
import cliProgress from 'cli-progress';

const sourcesDir = './sources/';
const outputDir = './fvect/';
const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

interface SpectrumOutput {
    songId: string;
    vector: number[];
}

function extractFeatures(audioBuffer: Float32Array, sampleRate: number): number[] {
    const features: number[][] = [];
    const numFrames = Math.floor((audioBuffer.length - FRAME_SIZE) / HOP_SIZE) + 1;

    for (let i = 0; i < numFrames; i++) {
        const start = i * HOP_SIZE;
        const frame = audioBuffer.slice(start, start + FRAME_SIZE);
        const extracted = Meyda.extract(
            [
                'rms',
                'zcr',
                'energy',
                'spectralCentroid',
                'spectralFlatness',
                'spectralRolloff',
                'spectralSpread',
                'spectralSkewness',
                'spectralKurtosis',
                'spectralSlope',
                'perceptualSpread',
                'perceptualSharpness',
                'mfcc',
            ],
            frame,
        );
        if (extracted && extracted.mfcc) {
            const frameFeatures = [
                extracted.rms ?? 0,
                extracted.zcr ?? 0,
                extracted.energy ?? 0,
                extracted.spectralCentroid ?? 0,
                extracted.spectralFlatness ?? 0,
                extracted.spectralRolloff ?? 0,
                extracted.spectralSpread ?? 0,
                extracted.spectralSkewness ?? 0,
                extracted.spectralKurtosis ?? 0,
                extracted.spectralSlope ?? 0,
                extracted.perceptualSpread ?? 0,
                extracted.perceptualSharpness ?? 0,
                ...extracted.mfcc
            ];

            features.push(frameFeatures);
        } else {
            console.error(`Failed to extract features at frame ${i}. Skipping frame.`);
        }
    }

	if (features.length === 0) {
		throw new Error('No features extracted from audio buffer.');
	}

    // Calculate delta and delta-delta features
    const deltas = calculateDeltas(features);
    const deltaDeltas = calculateDeltas(deltas);

    // Aggregate statistics across all frames
    const aggregatedFeatures = aggregateStatistics(features);
    const aggregatedDeltas = aggregateStatistics(deltas);
    const aggregatedDeltaDeltas = aggregateStatistics(deltaDeltas);

    return [...aggregatedFeatures, ...aggregatedDeltas, ...aggregatedDeltaDeltas];
}

function calculateDeltas(data: number[][]): number[][] {
    const deltas: number[][] = [];
    for (let i = 0; i < data.length; i++) {
        const previous = i > 0 ? data[i - 1] : data[i];
        const next = i < data.length - 1 ? data[i + 1] : data[i];
        const delta = next.map((val, idx) => (val - previous[idx]) / 2);
        deltas.push(delta);
    }
    return deltas;
}

function aggregateStatistics(features: number[][]): number[] {
    const numFeatures = features[0].length;
    const aggregated: number[] = [];

    for (let i = 0; i < numFeatures; i++) {
        const values = features.map(frame => frame[i]);
        const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        const skewness = values.reduce((sum, val) => sum + Math.pow(val - mean, 3), 0) / values.length / Math.pow(variance, 1.5);
        const kurtosis = values.reduce((sum, val) => sum + Math.pow(val - mean, 4), 0) / values.length / Math.pow(variance, 2) - 3;

        aggregated.push(mean, variance, skewness, kurtosis);
    }

    return aggregated;
}

function processFile(filePath: string, songId: string) {
    if (existsSync(join(outputDir, `${songId}.json`))) {
        console.log(`Skipping ${songId}, feature vector already exists.`);
        return;
    }

    const buffer = readFileSync(filePath);
    const result = decode(buffer);
    const audioBuffer = result.channelData[0]; // Assuming mono audio
    const sampleRate = result.sampleRate;

	try {
		const featureVector = extractFeatures(audioBuffer, sampleRate);
		const normalizedFeatureVector = normalize(featureVector);

		const output: SpectrumOutput = {
			songId,
			vector: normalizedFeatureVector
		};

		writeFileSync(join(outputDir, `${songId}.json`), JSON.stringify(output));
		console.log(`Processed ${songId}, feature vector length: ${normalizedFeatureVector.length}`);
	} catch (ex) {
		console.error("Failed to extract features for file:", filePath, "Error:", ex);
	}
}

function normalize(features: number[]): number[] {
    const min = Math.min(...features);
    const max = Math.max(...features);
    return features.map(value => (value - min) / (max - min));
}

async function main() {
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir);
    }

    const files = readdirSync(sourcesDir).filter(file => extname(file) === '.wav');
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(files.length, 0);

    for (const [index, file] of files.entries()) {
        const songId = basename(file, extname(file));
        await processFile(join(sourcesDir, file), songId);
        progressBar.update(index + 1);
    }

    progressBar.stop();
}

main().catch(console.error);
