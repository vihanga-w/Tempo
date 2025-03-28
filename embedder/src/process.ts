import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, promises } from 'fs';
import { basename, extname, join } from 'path';
import { decode } from 'node-wav';
import Meyda from 'meyda';
import { AudioContext } from 'web-audio-api';
import cliProgress from 'cli-progress';

const sourcesDir = './sources/';
const outputDir = './fvect/';
const FFT_SIZE = 4096;

interface SpectrumOutput {
    songId: string;
    vector: number[];
}

async function getAudioBuffer(filePath: string): Promise<Float32Array> {
    const buffer = await promises.readFile(filePath);
    const result = decode(buffer);
    return result.channelData[0]; // Assuming mono audio
}

async function getSampleRate(filePath: string): Promise<number> {
    const buffer = await promises.readFile(filePath);
    const result = decode(buffer);
    return result.sampleRate;
}

function extractFeatures(audioBuffer: Float32Array, sampleRate: number): number[] {
    const features = Meyda.extract(
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
        audioBuffer
    );

    if (!features) {
        throw new Error('Feature extraction failed.');
    }

    const featureVector = [
        features.rms || 0,
        features.zcr || 0,
        features.energy || 0,
        features.spectralCentroid || 0,
        features.spectralFlatness || 0,
        features.spectralRolloff || 0,
        features.spectralSpread || 0,
        features.spectralSkewness || 0,
        features.spectralKurtosis || 0,
        features.spectralSlope || 0,
        features.perceptualSpread || 0,
        features.perceptualSharpness || 0,
        ...(features.mfcc || Array(13).fill(0)), // Default to 13 MFCCs
    ];

    return featureVector;
}

function normalizeFeatureVector(featureVector: number[]): number[] {
    const min = Math.min(...featureVector);
    const max = Math.max(...featureVector);
    return featureVector.map(value => (value - min) / (max - min));
}

async function processFile(filePath: string, songId: string) {
    if (existsSync(join(outputDir, `${songId}.json`))) {
        console.log(`Skipping processing ${songId} as feature vector already exists.`);
        return;
    }

    try {
        const audioBuffer = await getAudioBuffer(filePath);
        const sampleRate = await getSampleRate(filePath);
        const featureVector = extractFeatures(audioBuffer, sampleRate);
        const normalizedFeatureVector = normalizeFeatureVector(featureVector);

        const output: SpectrumOutput = {
            songId: songId,
            vector: normalizedFeatureVector,
        };

        writeFileSync(join(outputDir, `${songId}.json`), JSON.stringify(output));
        console.log(`Processed ${songId}, generated a ${normalizedFeatureVector.length}-dimensional feature vector.`);
    } catch (error) {
        console.error(`Error processing file ${songId}:`, error);
    }
}

async function main() {
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir);
    }

    const files = readdirSync(sourcesDir).filter(file => extname(file) === '.wav');

    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(files.length, 0);

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const songId = basename(file, extname(file));
        await processFile(join(sourcesDir, file), songId);
        progressBar.update(i + 1);
    }

    progressBar.stop();
}

main().catch(console.error);
