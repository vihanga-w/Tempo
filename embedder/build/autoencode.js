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
Object.defineProperty(exports, "__esModule", { value: true });
const tf = __importStar(require("@tensorflow/tfjs-node"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const autoencoder_1 = require("./autoencoder"); // Import from autoencoder.ts
const inputDim = 8218; // Updated feature dimension
const encodingDim = 128; // Desired latent space dimension
// ----- Prepare Training Data -----
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
// ----- Train the Autoencoder -----
(0, autoencoder_1.trainAutoencoder)(X).then(() => {
    // ----- Create an Encoder Model -----
    // We build a separate model that maps input features to the embedding (bottleneck layer).
    const encoder = tf.sequential();
    encoder.add(autoencoder_1.autoencoder.layers[0]); // First layer (8218 -> 1024)
    encoder.add(autoencoder_1.autoencoder.layers[1]); // Second layer (1024 -> 512)
    encoder.add(autoencoder_1.autoencoder.layers[2]); // Bottleneck layer (512 -> 128)
    // Ensure the layers are built
    encoder.build([null, inputDim]);
    // Get the embeddings for all vectors
    const embeddings = encoder.predict(X);
    const embeddingArray = embeddings.arraySync();
    // Create the embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDir)) {
        fs.mkdirSync(embeddingDir);
    }
    // Save the embeddings to files
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
