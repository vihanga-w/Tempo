import { promises as fs, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { Transform } from 'stream';
import FFT from 'fft.js';
import { decode } from 'node-wav';
import Meyda from 'meyda';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';
import getPixels from 'get-pixels';
import os from 'os';
import { SongDataCache } from '../../embedder/src/song-data-cache';
import { performance } from 'perf_hooks';

const sourcesDir = './sources';
const outputDir = './fvect';
const TARGET_VECTOR_LENGTH = 1855;
const FFT_SIZE = 4096;
const BATCH_SIZE = 5;
const meta = new SongDataCache('./song-data-cache');

interface SpectrumOutput {
    songId: string;
    vector: number[];
}

let researchRequiredSongIds: string[] = [];
let failedSongs: { songId: string; reason: string }[] = [];

class FFTTransform extends Transform {
    private fft: FFT;
    private buffer: Float32Array;
    private bufferIndex: number;

    constructor(fftSize: number) {
        super({ readableObjectMode: true });
        this.fft = new FFT(fftSize);
        this.buffer = new Float32Array(fftSize);
        this.bufferIndex = 0;
    }

    _transform(chunk: Buffer, _: string, callback: Function) {
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let i = 0; i < chunk.length / 2; i++) {
            this.buffer[this.bufferIndex++] = view.getInt16(i * 2, true) / 32768;
            if (this.bufferIndex === this.buffer.length) {
                const spectrum = this.fft.createComplexArray();
                this.fft.realTransform(spectrum, this.buffer);
                this.fft.completeSpectrum(spectrum);
                this.push(Array.from(spectrum).map(c => c || 0)); // Avoid nulls
                this.bufferIndex = 0;
            }
        }
        callback();
    }
}

async function fetchLowQualityAlbumCover(songId: string): Promise<number[]> {
    const artUrl = meta.getItem(songId)?.album.artUrl;
    if (!artUrl) throw new Error(`No album art found for ${songId}`);

    const url = `https://imgcdn.tempo-music.co/scdn/${artUrl.split('/image/')[1]}?s=8x8&noconv=t`;

    return new Promise((resolve, reject) => {
        getPixels(url, (err, pixels) => {
            if (err) return reject(new Error(`Failed to fetch album art for ${songId}`));
            resolve(Array.from(Buffer.from(pixels.data)));
        });
    });
}

function normalizeArray(arr: number[]): number[] {
    const safe = arr.map(x => isFinite(x) ? x : 0);
    const min = Math.min(...safe);
    const max = Math.max(...safe);
    if (min === max) return safe.map(() => 0);
    return safe.map(v => (v - min) / (max - min));
}

function normalizeMetadata(metadataValues: number[]): number[] {
    // Step 1: Apply log(1 + abs(x)) transform to reduce the impact of huge outliers
    const logTransformed = metadataValues.map(v => Math.log1p(Math.abs(v)));

    // Step 2: Min-max normalize the log-transformed values to [0, 1]
    const min = Math.min(...logTransformed);
    const max = Math.max(...logTransformed);

    if (max === min) {
        // Avoid division by zero if metadata is weird (constant)
        return logTransformed.map(() => 0);
    }

    const normalized = logTransformed.map(v => (v - min) / (max - min));
    return normalized;
}

function globalAveragePooling(fftMatrix: number[][]): number[] {
	const timeSteps = fftMatrix.length;
	const freqBins = fftMatrix[0].length;
	const pooled = new Array(freqBins).fill(0);

	fftMatrix.forEach(frame => {
		frame.forEach((value, i) => {
			pooled[i] += value;
		});
	});

	// Divide by number of frames
	return pooled.map(x => x / timeSteps);
}

async function processFile(filePath: string, songId: string): Promise<void> {
    if (existsSync(join(outputDir, `${songId}.json`))) return;

    const metadataPath = `./fext/${songId}.wav.json`;
    if (!existsSync(metadataPath)) throw new Error(`Missing metadata for ${songId}`);

    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

    const readStream = createReadStream(filePath);
    const fftTransform = new FFTTransform(FFT_SIZE);

    const temporalSpectrum: number[][] = [];
    const audioChunks: Buffer[] = [];
    const albumImgPromise = fetchLowQualityAlbumCover(songId).catch(() => []);

    readStream.on('data', (chunk: string | Buffer) => {
        if (Buffer.isBuffer(chunk)) {
            audioChunks.push(chunk);
        } else {
            audioChunks.push(Buffer.from(chunk));
        }
    });
    readStream.pipe(fftTransform).on('data', (spectrum: number[]) => temporalSpectrum.push(spectrum));

    await new Promise<void>((resolve, reject) => {
        readStream.on('end', resolve);
        readStream.on('error', reject);
    });

    const BUCKET_COUNT = 72;
    const bucketSize = Math.ceil(temporalSpectrum.length / BUCKET_COUNT);
    const featureVector: number[] = [];

    for (let i = 0; i < BUCKET_COUNT; i++) {
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, temporalSpectrum.length);
        const bucket = temporalSpectrum.slice(start, end);

        if (bucket.length > 0) {
            const avg = globalAveragePooling(bucket);
            const features = Meyda.extract([
                'mfcc', 'rms', 'spectralCentroid', 'spectralFlatness', 'spectralRolloff', 'zcr',
                'spectralSpread', 'spectralSkewness', 'spectralKurtosis', 'spectralSlope',
                'energy', 'perceptualSpread', 'perceptualSharpness'
            ], avg);

            if (features) {
                featureVector.push(
                    ...(features.mfcc || []),
                    features.rms || 0,
                    features.spectralCentroid || 0,
                    features.spectralFlatness || 0,
                    features.spectralRolloff || 0,
                    features.zcr || 0,
                    features.spectralSpread || 0,
                    features.spectralSkewness || 0,
                    features.spectralKurtosis || 0,
                    features.spectralSlope || 0,
                    features.energy || 0,
                    features.perceptualSpread || 0,
                    features.perceptualSharpness || 0
                );
            }
        }
    }

    const { channelData, sampleRate } = decode(await fs.readFile(filePath));
    const duration = channelData[0].length / sampleRate;
    featureVector.push(Math.min(duration / 600, 1));

    const albumArt = await albumImgPromise;
    featureVector.push(...albumArt.map(b => b / 255));

    featureVector.push(metadata.tempo || 0);

    featureVector.push(...normalizeMetadata([
        metadata.total_beats, metadata.average_beats,
        metadata.chroma_stft_mean, metadata.chroma_stft_std, metadata.chroma_stft_var,
        metadata.chroma_cq_mean, metadata.chroma_cq_std, metadata.chroma_cq_var,
        metadata.chroma_cens_mean, metadata.chroma_cens_std, metadata.chroma_cens_var,
        metadata.melspectrogram_mean, metadata.melspectrogram_std, metadata.melspectrogram_var,
        metadata.mfcc_mean, metadata.mfcc_std, metadata.mfcc_var,
        metadata.mfcc_delta_mean, metadata.mfcc_delta_std, metadata.mfcc_delta_var,
        metadata.rms_mean, metadata.rms_std, metadata.rms_var,
        metadata.cent_mean, metadata.cent_std, metadata.cent_var,
        metadata.spec_bw_mean, metadata.spec_bw_std, metadata.spec_bw_var,
        metadata.contrast_mean, metadata.contrast_std, metadata.contrast_var,
        metadata.rolloff_mean, metadata.rolloff_std, metadata.rolloff_var,
        metadata.poly_mean, metadata.poly_std, metadata.poly_var,
        metadata.tonnetz_mean, metadata.tonnetz_std, metadata.tonnetz_var,
        metadata.zcr_mean, metadata.zcr_std, metadata.zcr_var,
        metadata.harm_mean, metadata.harm_std, metadata.harm_var,
        metadata.perc_mean, metadata.perc_std, metadata.perc_var,
        metadata.frame_mean, metadata.frame_std, metadata.frame_var
    ]));

    const normalizedVector = normalizeArray(featureVector);

    const finalVector = normalizedVector.length > TARGET_VECTOR_LENGTH
        ? normalizedVector.slice(0, TARGET_VECTOR_LENGTH)
        : [...normalizedVector, ...Array(TARGET_VECTOR_LENGTH - normalizedVector.length).fill(0)];

    writeFileSync(join(outputDir, `${songId}.json`), JSON.stringify({ songId, vector: finalVector }));
}

async function main() {
    if (!existsSync(outputDir)) mkdirSync(outputDir);

    const files = (await fs.readdir(sourcesDir)).filter(f => extname(f) === '.wav');
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(files.length, 0);

    let completed = 0;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(async file => {
            const songId = basename(file, extname(file));
            try {
                await processFile(join(sourcesDir, file), songId);
            } catch (err: any) {
                failedSongs.push({ songId, reason: err.message });
            } finally {
                completed++;
                progressBar.update(completed);
            }
        }));
    }

    progressBar.stop();

    if (failedSongs.length > 0) {
        writeFileSync('failed-songs.json', JSON.stringify(failedSongs, null, 2));
        console.error(`[Error] ${failedSongs.length} files failed.`);
    } else {
        console.log(`[Info] All files processed successfully.`);
    }
}

main().catch(error => {
    console.error(`[Fatal] Pipeline failed:`, error);
});
