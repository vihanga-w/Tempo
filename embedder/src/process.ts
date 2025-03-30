import { writeFileSync, readFileSync, readdirSync, promises, existsSync, mkdirSync } from 'fs';
import { basename, extname, join } from 'path';
import { createReadStream } from 'fs';
import { Transform } from 'stream';
import FFT from 'fft.js';
import { decode } from 'node-wav';
import Meyda from 'meyda';
import MusicTempo from 'music-tempo';
import { AudioContext } from 'web-audio-api';
import cliProgress from 'cli-progress';

const sourcesDir = './sources/';
const outputDir = './fvect/';
const FFT_SIZE = 4096;

interface SpectrumOutput {
	songId: string;
	vector: number[];
}

async function getSampleRate(filePath: string): Promise<number> {
	const buffer = await promises.readFile(filePath);
	const result = decode(buffer); // Use node-wav to decode
	return result.sampleRate;
}

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

	_transform(chunk: Buffer, encoding: string, callback: Function) {
		const floatChunk = new Float32Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength).byteLength / Float32Array.BYTES_PER_ELEMENT);
		const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

		for (let i = 0; i < floatChunk.length; i++) {
			floatChunk[i] = view.getInt16(i * 2, true) / 32768; // Convert to [-1, 1] range
		}

		for (let i = 0; i < floatChunk.length; i++) {
			this.buffer[this.bufferIndex++] = floatChunk[i];

			if (this.bufferIndex === this.buffer.length) {
				const spectrum = this.fft.createComplexArray();
				this.fft.realTransform(spectrum, this.buffer);
				this.fft.completeSpectrum(spectrum);
				this.push(Array.from(spectrum).map(c => c || 0)); // Ensure no null values
				this.bufferIndex = 0;
			}
		}

		callback();
	}
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

function logCompress(data: number[]): number[] {
	return data.map(value => Math.log(1 + value));
}

let researchRequiredSongIds: string[] = [];

function processFile(filePath: string, songId: string) {
	return new Promise<void>((resolve, reject) => {
		if (existsSync(join(outputDir, `${songId}.json`))) {
			console.log("Skipping processing", songId, "as we already have a feature vector for it");

			return resolve();
		}

		const readStream = createReadStream(filePath);
		const fftTransform = new FFTTransform(FFT_SIZE);

		let temporalSpectrum: number[][] = [];
		let audioBuffer: Buffer[] = [];

		console.log(`Processing frequency distribution for ${songId}`);

		readStream.on('data', (chunk: string | Buffer) => {
			if (typeof chunk === 'string') {
				chunk = Buffer.from(chunk);
			}
			audioBuffer.push(chunk);
		});

		readStream.pipe(fftTransform).on('data', (spectrum: number[]) => {
			temporalSpectrum.push(spectrum);
		})
		.on('end', async () => {
			try {
				const BUCKET_SIZE = 48;

				// Split the spectrum into ~even sized buckets
				const bucketSize = Math.ceil(temporalSpectrum.length / BUCKET_SIZE);

				let buckets: number[][][] = [];

				for (let i = 0; i < BUCKET_SIZE; i++) {
					const start = i * bucketSize;
					const end = Math.min(start + bucketSize, temporalSpectrum.length);
					buckets.push(temporalSpectrum.slice(start, end));
				}

				let featureVector: number[] = [];
				let tempFeatureVectors: number[] = [];

				let pools: number[][] = [];

				for (const bucket of buckets) {
                    if (bucket.length == 0)
                        continue;

					pools.push(globalAveragePooling(bucket));
				}

				pools.forEach((avg, i) => {
					// Compute MFCCs and additional features using Meyda
					const features = Meyda.extract([
						'mfcc', 'rms', 'spectralCentroid', 'spectralFlatness', 'spectralRolloff', 'zcr',
						'spectralSpread', 'spectralSkewness', 'spectralKurtosis', 'spectralSlope',
						'energy', 'perceptualSpread', 'perceptualSharpness'
					], avg, (i >= 1 ? pools[i-1] : undefined));

					if (!features) {
						console.error(`Failed to extract features for ${songId}`);
						return reject(new Error(`Failed to extract features for ${songId}`));
					}

					const mfccs = features.mfcc || [];

					// Log-compress the raw FFT data
					const logCompressedFFT = logCompress(avg);

					// Concatenate additional features and log-compressed FFT data
					const localFeatureVector = [
						...mfccs,
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
						features.perceptualSharpness || 0,
						// ...logCompressedFFT
					].map(f => f || 0); // Ensure no null values

					tempFeatureVectors = [...tempFeatureVectors, ...[...localFeatureVector, ...[1,1,1,1,1]]];
				});

				// Song average
				const avg = globalAveragePooling(temporalSpectrum);

				// Compute MFCCs and additional features using Meyda
				const features = Meyda.extract([
					'mfcc', 'rms', 'spectralCentroid', 'spectralFlatness', 'spectralRolloff', 'zcr',
					'spectralSpread', 'spectralSkewness', 'spectralKurtosis', 'spectralSlope',
					'energy', 'perceptualSpread', 'perceptualSharpness'
				], avg);

				if (!features) {
					console.error(`Failed to extract features for ${songId}`);
					return reject(new Error(`Failed to extract features for ${songId}`));
				}

				const mfccs = features.mfcc || [];

				// Log-compress the raw FFT data
				const logCompressedFFT = logCompress(avg);

				// Concatenate additional features and log-compressed FFT data
				const localFeatureVector = [
					...mfccs,
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
					features.perceptualSharpness || 0,
					// ...logCompressedFFT
				].map(f => f || 0); // Ensure no null values

				tempFeatureVectors = [...tempFeatureVectors, ...[...localFeatureVector, ...[1,1,1,1,1]]];
				// tempFeatureVectors.push(localFeatureVector);

				featureVector = [...featureVector, ...tempFeatureVectors];

				// Extract song duration
				const buffer = await promises.readFile(filePath);
				const result = decode(buffer);
				
				const duration = result.channelData[0].length / result.sampleRate;

				console.log(`Duration: ${duration}`);

				featureVector.push(duration);

				// Check if the song JSON includes tempo
				const songsJsonPath = 'songs.json';

				let tempo: number | null = null;

				if (existsSync(songsJsonPath)) {
					const songsJson = JSON.parse(readFileSync(songsJsonPath, 'utf8'));
					console.log(songsJson[songId]);
					if (songsJson[songId] && songsJson[songId].tempo) {
						tempo = songsJson[songId].tempo;
					}
				}

                const tempoProcessCompleteCb = (featureVector: number[]) => {
                    const safeFeatureVector = featureVector.map(value => 
                        isFinite(value) ? value : 0
                    );

                    // Normalize the entire feature vector between 0 and 1
                    const min = Math.min(...safeFeatureVector);
                    const max = Math.max(...safeFeatureVector);

                    if (min === max) {
                        return reject(`Feature vector min and max are equal for ${songId}. Skipping normalization.`);
                    } else {
                        console.log("normMinMax:", min, max)
                    }

                    let normalizedFeatureVector = safeFeatureVector.map(value => (value - min) / (max - min));

                    console.log(normalizedFeatureVector.length)

                    if (normalizedFeatureVector.length > 1472)
                        reject("Invalid feature vector length: " + normalizedFeatureVector.length + " (too large to pad)");
                    else if (normalizedFeatureVector.length < 1472)
                        normalizedFeatureVector = [...normalizedFeatureVector, ...Array(1472 - normalizedFeatureVector.length).fill(0)];

                    if (normalizedFeatureVector.length > 1472)
                        writeFileSync("nferrlen", normalizedFeatureVector.length.toString())

                    const output: SpectrumOutput = {
                        songId: songId,
                        vector: normalizedFeatureVector
                    };

                    writeFileSync(join(outputDir, `${songId}.json`), JSON.stringify(output));

                    console.log(`Finished processing ${songId}, generated a ${normalizedFeatureVector.length} dimensional feature vector`);

                    resolve();
                }

				if (tempo === null) {
					// Calculate tempo using the music-tempo library
					const audioBufferConcat = Buffer.concat(audioBuffer);
					const context = new AudioContext();
					context.decodeAudioData(audioBufferConcat.buffer, (buffer: AudioBuffer) => {
						const audioData = [];
						if (buffer.numberOfChannels === 2) {
							const channel1Data = buffer.getChannelData(0);
							const channel2Data = buffer.getChannelData(1);
							const length = channel1Data.length;
							for (let i = 0; i < length; i++) {
								audioData[i] = (channel1Data[i] + channel2Data[i]) / 2;
							}
						} else {
							audioData.push(...buffer.getChannelData(0));
						}

						try {
							const mt = new MusicTempo(audioData);
							console.log("tempo:", mt.tempo);
							featureVector.push(mt.tempo);
						} catch (ex) {
							researchRequiredSongIds.push(songId);

							writeFileSync("research-needed-songs.json", JSON.stringify(researchRequiredSongIds));

							return reject(ex);
						}

                        tempoProcessCompleteCb(featureVector);
					}, (error: DOMException) => {
						console.error(`Error decoding audio data for ${songId}:`, error);
						resolve();
					});
				} else {
					featureVector.push(tempo);

                    tempoProcessCompleteCb(featureVector);
				}
			} catch (error) {
				console.error(`Error processing file ${songId}:`, error);
				reject(error);
			}
		});
	});
}

async function main() {
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir);
	}

	const files = readdirSync(sourcesDir).filter(file => extname(file) === '.wav');

	const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
	progressBar.start(files.length, 0);

	console.clear();

	let completed = 0;
	const concurrencyLimit = 10;
	const updateProgress = () => {
		completed++;
		progressBar.update(completed);
	};

	// Helper function to process files in batches
    const processBatch = async (batch: string[]): Promise<void> => {
        await Promise.allSettled(batch.map(async (file: string): Promise<void> => {
            const songId: string = basename(file, extname(file));
            try {
                await processFile(join(sourcesDir, file), songId);
            } catch (error: unknown) {
                console.error(`Failed to process file ${file}:`, error);
            } finally {
                updateProgress();
            }
        }));
    };

	// Split files into batches
	for (let i = 0; i < files.length; i += concurrencyLimit) {
		const batch = files.slice(i, i + concurrencyLimit);
		await processBatch(batch); // Wait for the batch to finish before starting the next one
	}

	progressBar.stop();

	console.log("Processing finished", `(${files.length} files have been ingested and processed)`, (researchRequiredSongIds.length > 0 ? `(${researchRequiredSongIds.length} songs need manual tempo entry, see ./research-needed-songs.json)` : ""));
}

main().catch(console.error);