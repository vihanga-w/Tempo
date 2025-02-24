"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fs_1 = require("fs");
const stream_1 = require("stream");
const fft_js_1 = __importDefault(require("fft.js"));
const wav = __importStar(require("node-wav"));
const meyda_1 = __importDefault(require("meyda"));
const music_tempo_1 = __importDefault(require("music-tempo"));
const web_audio_api_1 = require("web-audio-api");
const sourcesDir = './sources/';
const outputDir = './fvect/';
const FFT_SIZE = 4096;
function getSampleRate(filePath) {
    return __awaiter(this, void 0, void 0, function* () {
        const buffer = yield fs.promises.readFile(filePath);
        const result = wav.decode(buffer); // Use node-wav to decode
        return result.sampleRate;
    });
}
class FFTTransform extends stream_1.Transform {
    constructor(fftSize) {
        super({ readableObjectMode: true });
        this.fft = new fft_js_1.default(fftSize);
        this.buffer = new Float32Array(fftSize);
        this.bufferIndex = 0;
    }
    _transform(chunk, encoding, callback) {
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
function globalAveragePooling(fftMatrix) {
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
function logCompress(data) {
    return data.map(value => Math.log(1 + value));
}
function processFile(filePath, songId) {
    return new Promise((resolve, reject) => {
        const readStream = (0, fs_1.createReadStream)(filePath);
        const fftTransform = new FFTTransform(FFT_SIZE);
        let temporalSpectrum = [];
        let audioBuffer = [];
        console.log(`Processing frequency distribution for ${songId}`);
        readStream.on('data', (chunk) => {
            if (typeof chunk === 'string') {
                chunk = Buffer.from(chunk);
            }
            audioBuffer.push(chunk);
        });
        readStream.pipe(fftTransform).on('data', (spectrum) => {
            temporalSpectrum.push(spectrum);
        })
            .on('end', () => __awaiter(this, void 0, void 0, function* () {
            try {
                const avg = globalAveragePooling(temporalSpectrum);
                // Compute MFCCs and additional features using Meyda
                const features = meyda_1.default.extract([
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
                const featureVector = [
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
                    ...logCompressedFFT
                ].map(f => f || 0); // Ensure no null values
                // Check if the song JSON includes tempo
                const songsJsonPath = 'songs.json';
                let tempo = null;
                if (fs.existsSync(songsJsonPath)) {
                    const songsJson = JSON.parse(fs.readFileSync(songsJsonPath, 'utf8'));
                    console.log(songsJson[songId]);
                    if (songsJson[songId] && songsJson[songId].tempo) {
                        tempo = songsJson[songId].tempo;
                    }
                }
                if (tempo === null) {
                    // Calculate tempo using the music-tempo library
                    const audioBufferConcat = Buffer.concat(audioBuffer);
                    const context = new web_audio_api_1.AudioContext();
                    context.decodeAudioData(audioBufferConcat.buffer, (buffer) => {
                        const audioData = [];
                        if (buffer.numberOfChannels === 2) {
                            const channel1Data = buffer.getChannelData(0);
                            const channel2Data = buffer.getChannelData(1);
                            const length = channel1Data.length;
                            for (let i = 0; i < length; i++) {
                                audioData[i] = (channel1Data[i] + channel2Data[i]) / 2;
                            }
                        }
                        else {
                            audioData.push(...buffer.getChannelData(0));
                        }
                        const mt = new music_tempo_1.default(audioData);
                        console.log("tempo:", mt.tempo);
                        featureVector.push(mt.tempo);
                        // Normalize the entire feature vector between 0 and 1
                        const min = Math.min(...featureVector);
                        const max = Math.max(...featureVector);
                        const normalizedFeatureVector = featureVector.map(value => (value - min) / (max - min));
                        console.log(normalizedFeatureVector.length);
                        const output = {
                            songId: songId,
                            vector: normalizedFeatureVector
                        };
                        fs.writeFileSync(path.join(outputDir, `${songId}.json`), JSON.stringify(output));
                        console.log(`Finished processing ${songId}, generated a ${normalizedFeatureVector.length} dimensional feature vector`);
                        resolve();
                    }, (error) => {
                        console.error(`Error decoding audio data for ${songId}:`, error);
                        reject(error);
                    });
                }
                else {
                    featureVector.push(tempo);
                    // Normalize the entire feature vector between 0 and 1
                    const min = Math.min(...featureVector);
                    const max = Math.max(...featureVector);
                    const normalizedFeatureVector = featureVector.map(value => (value - min) / (max - min));
                    console.log(normalizedFeatureVector.length);
                    const output = {
                        songId: songId,
                        vector: normalizedFeatureVector
                    };
                    fs.writeFileSync(path.join(outputDir, `${songId}.json`), JSON.stringify(output));
                    console.log(`Finished processing ${songId}, generated a ${normalizedFeatureVector.length} dimensional feature vector`);
                    resolve();
                }
            }
            catch (error) {
                console.error(`Error processing file ${songId}:`, error);
                reject(error);
            }
        }));
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const files = fs.readdirSync(sourcesDir).filter(file => path.extname(file) === '.wav');
        const batchSize = 5;
        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize).map(file => {
                const songId = path.basename(file, path.extname(file));
                return processFile(path.join(sourcesDir, file), songId);
            });
            try {
                yield Promise.all(batch);
            }
            catch (error) {
                console.error(`Failed to process batch:`, error);
            }
        }
    });
}
main().catch(console.error);
