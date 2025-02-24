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
Object.defineProperty(exports, "__esModule", { value: true });
const tf = __importStar(require("@tensorflow/tfjs-node"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const inputDim = 8218; // Updated input dimension
const encodingDim = 128; // Dimension of the encoding space
// 8218 --> 1024 --> 512 --> 128
const encoder = tf.sequential();
encoder.add(tf.layers.dense({ inputShape: [inputDim], units: 1024, activation: 'relu' }));
encoder.add(tf.layers.dense({ units: 512, activation: 'relu' }));
encoder.add(tf.layers.dense({ units: encodingDim, activation: 'relu' }));
// 128 --> 512 --> 1024 --> 8218
const decoder = tf.sequential();
decoder.add(tf.layers.dense({ inputShape: [encodingDim], units: 512, activation: 'relu' }));
decoder.add(tf.layers.dense({ units: 1024, activation: 'relu' }));
decoder.add(tf.layers.dense({ units: inputDim, activation: 'sigmoid' }));
const autoencoder = tf.sequential();
autoencoder.add(encoder);
autoencoder.add(decoder);
autoencoder.compile({ optimizer: 'adam', loss: 'meanSquaredError' });
function trainAutoencoder(data) {
    return __awaiter(this, void 0, void 0, function* () {
        const epochs = 50;
        const batchSize = 32;
        // Ensure the input data is reshaped to match the input dimension
        if (data.shape[1] !== inputDim) {
            throw new Error(`Input data must have ${inputDim} features, but has ${data.shape[1]}`);
        }
        const reshapedData = data.reshape([-1, inputDim]);
        console.log(`Reshaped data dimensions: ${reshapedData.shape}`);
        yield autoencoder.fit(reshapedData, reshapedData, {
            epochs,
            batchSize,
            validationSplit: 0.2,
            callbacks: tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 5 })
        });
    });
}
// Prepare training dataset
const fvectDir = './fvect/';
const embeddingDir = './embeddings/';
const files = fs.readdirSync(fvectDir).filter(file => path.extname(file) === '.json');
const data = files.map(file => {
    const content = JSON.parse(fs.readFileSync(path.join(fvectDir, file), 'utf8'));
    return content.vector;
});
// Normalize the input data
const normalizedData = data.map(vector => {
    const min = Math.min(...vector);
    const max = Math.max(...vector);
    return vector.map((value) => (value - min) / (max - min));
});
const X = tf.tensor2d(normalizedData, [normalizedData.length, inputDim]);
// Train the autoencoder
trainAutoencoder(X).then(() => {
    const encoderModel = tf.sequential();
    encoderModel.add(tf.layers.dense({ inputShape: [inputDim], units: 1024, activation: 'relu' }));
    encoderModel.add(tf.layers.dense({ units: 512, activation: 'relu' }));
    // Bottleneck layer
    encoderModel.add(tf.layers.dense({ units: encodingDim, activation: 'relu' }));
    encoderModel.build([null, inputDim]);
    // Get the embeddings for all vectors
    const embeddings = encoderModel.predict(X);
    const embeddingArray = embeddings.arraySync();
    if (!fs.existsSync(embeddingDir)) {
        fs.mkdirSync(embeddingDir);
    }
    files.forEach((file, index) => {
        const songId = path.basename(file, path.extname(file));
        const output = {
            songId: songId,
            embedding: embeddingArray[index]
        };
        fs.writeFileSync(path.join(embeddingDir, `${songId}_embedding.json`), JSON.stringify(output));
    });
    console.log('Embeddings saved to files in the embeddings directory');
});
