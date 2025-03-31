import * as tf from '@tensorflow/tfjs-node';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { basename, extname, join } from 'path';
import { createInterface } from 'readline';
import { io } from '@tensorflow/tfjs-core'; // Import IO types from tfjs-core

// Define the interface for embedding output (optional)
export interface EmbeddingOutput {
  songId: string;
  embedding: number[];
}

// Updated dimensions from the second file
const inputDim = 1227; // Updated input dimension
const encodingDim = 512; // Dimension of the encoding space
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB
const EMBEDDING_VERSION = 1;

// Directories
const fvectDir = './fvect/';
const embeddingDir = './embeddings/';
const savedModelDir = './saved_autoencoder';

/**
 * Utility function to concatenate array buffers.
 */
function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return result.buffer;
}

/**
 * Custom IOHandler to save the model with weight splitting.
 */
const customIOHandler: io.IOHandler = {
  save: async (modelArtifact: io.ModelArtifacts): Promise<io.SaveResult> => {
    const { modelTopology, weightSpecs, weightData } = modelArtifact;
    if (!weightData) {
      throw new Error("No weight data found!");
    }

    if (!existsSync(savedModelDir))
      mkdirSync(savedModelDir);

    // Process weightData as needed (e.g., concatenation if it's an array)
    const combinedWeightData = Array.isArray(weightData)
      ? concatArrayBuffers(weightData)
      : weightData;

    // Create a Uint8Array from the combined weight data.
    const weightArray = new Uint8Array(combinedWeightData);
    const numChunks = Math.ceil(weightArray.length / CHUNK_SIZE);
    const paths: string[] = [];
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, weightArray.length);
      const chunkData = weightArray.slice(start, end);
      const chunkFilename = `weights.bin.part${i}`;
      const chunkPath = join(savedModelDir, chunkFilename);
      writeFileSync(chunkPath, Buffer.from(chunkData));
      console.log(`Created chunk: ${chunkFilename}`);
      paths.push(chunkFilename);
    }

    // Create the weights manifest with the split files.
    const weightsManifest = [{
      paths,
      weights: weightSpecs
    }];
    const modelJSON = {
      modelTopology,
      weightsManifest
    };
    const modelJSONPath = join(savedModelDir, 'model.json');
    writeFileSync(modelJSONPath, JSON.stringify(modelJSON));
    console.log("Model JSON saved with split weight files.");

    return {
      modelArtifactsInfo: {
        dateSaved: new Date(),
        modelTopologyType: "JSON",
        weightDataBytes: weightArray.byteLength,
      }
    };
  }
};

/**
 * Build the autoencoder (and encoder) using the functional API with the updated architecture.
 *
 * Architecture:
 *  Encoder: [inputDim] -> Dense(1024) -> Dense(512) -> Dense(encodingDim)
 *  Decoder: Dense(512) -> Dense(1024) -> Dense(inputDim)
 */
function buildAutoencoder() {
  const inputLayer = tf.layers.input({ shape: [inputDim] });
  // Encoder
  const encoded1 = tf.layers.dense({ units: 1024, activation: 'elu' }).apply(inputLayer) as tf.SymbolicTensor;
  const encoded2 = tf.layers.dense({ units: 512, activation: 'elu' }).apply(encoded1) as tf.SymbolicTensor;
  const encodedOutput = tf.layers.dense({ units: encodingDim, activation: 'linear' }).apply(encoded2) as tf.SymbolicTensor;
  
  // Decoder
  const decoded1 = tf.layers.dense({ units: 512, activation: 'relu' }).apply(encodedOutput) as tf.SymbolicTensor;
  const decoded2 = tf.layers.dense({ units: 1024, activation: 'relu' }).apply(decoded1) as tf.SymbolicTensor;
  const decodedOutput = tf.layers.dense({ units: inputDim, activation: 'sigmoid' }).apply(decoded2) as tf.SymbolicTensor;
  
  const autoencoder = tf.model({ inputs: inputLayer, outputs: decodedOutput });
  autoencoder.compile({ optimizer: tf.train.adam(1e-4), loss: 'meanSquaredError' });
  const encoder = tf.model({ inputs: inputLayer, outputs: encodedOutput });
  console.log("Built a new autoencoder model using the updated architecture (functional API).");
  return { autoencoder, encoder };
}

/**
 * Load the saved autoencoder model if it exists.
 */
async function loadSavedModel() {
  const modelJSONPath = join(savedModelDir, 'model.json');
  if (existsSync(modelJSONPath)) {
    console.log(`Loading model from ${modelJSONPath}`);
    const loadedAutoencoder = await tf.loadLayersModel(`file://${modelJSONPath}`);
    // Rebuild the encoder with the same updated architecture.
    const inputLayer = tf.layers.input({ shape: [inputDim] });
    const encoded1 = tf.layers.dense({ units: 1024, activation: 'relu' }).apply(inputLayer) as tf.SymbolicTensor;
    const encoded2 = tf.layers.dense({ units: 512, activation: 'relu' }).apply(encoded1) as tf.SymbolicTensor;
    const encodedOutput = tf.layers.dense({ units: encodingDim, activation: 'relu' }).apply(encoded2) as tf.SymbolicTensor;
    const encoder = tf.model({ inputs: inputLayer, outputs: encodedOutput });
    // Assume the encoder weights are the first ones.
    encoder.setWeights(loadedAutoencoder.getWeights().slice(0, encoder.getWeights().length));
    return { autoencoder: loadedAutoencoder, encoder };
  }
  return null;
}

/**
 * Get the model: load a saved model if it exists, otherwise build a new one.
 */
async function getModel() {
  const saved = await loadSavedModel();
  if (saved) {
    return saved;
  }
  return buildAutoencoder();
}

const embeddingsFiles = readdirSync(embeddingDir).filter(file => file.endsWith('_embedding.json'));

/**
 * Generator to create dataset examples from JSON files.
 */
function* dataGeneratorFromDir(directory: string) {
  const files = readdirSync(directory).filter(file => extname(file) === '.json');
  for (const file of files) {
    const content = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    
    if (embeddingsFiles.includes(content.songId)) {
      const existingEmbedding = JSON.parse(readFileSync(embeddingDir + content.songId + "_embedding.json").toString());

      if (existingEmbedding.version && existingEmbedding.version == EMBEDDING_VERSION) {
        console.log(`Skipping file ${file} because a valid embedding already exists for it at ${embeddingDir}${content.songId}_embedding.json`);
        continue;
      } else {
        console.log(`Overwiting embedding at ${embeddingDir}${content.songId}_embedding.json because it has an invalid value for version: ${existingEmbedding.version}`);
      }
    }

    let vector = content.vector;

    if (vector.length !== inputDim)
      throw new Error("Feature vector at " + file + " has invalid dimensionality: " + vector.length.toString() + " (expected " + inputDim.toString() + ")");
    
    // Check for NaNs or Infinities
    if (vector.some((val: number) => isNaN(val) || !isFinite(val))) {
      console.warn(`Skipping file ${file} due to NaN or Infinity in vector.`);
      continue;
    }

    const min = Math.min(...vector);
    const max = Math.max(...vector);

    // Avoid division by zero in normalization
    if (min === max) {
      console.warn(`Skipping file ${file} because all values are the same.`);
      continue;
    }

    const normalizedVector: number[] = vector.map((value: number): number => (value - min) / (max - min));
    yield {
      xs: tf.tensor2d([normalizedVector]),
      ys: tf.tensor2d([normalizedVector])
    };
  }
}

/**
 * Create a tf.data.Dataset from the files in a directory.
 */
function createDataset(directory: string) {
  return tf.data
    .generator(() => dataGeneratorFromDir(directory))
    .batch(1)
    .prefetch(1) as tf.data.Dataset<{ xs: tf.Tensor, ys: tf.Tensor }>;
}

/**
 * Train the autoencoder on the dataset and save the model using the custom IO handler.
 */
async function trainAutoencoder(autoencoder: tf.LayersModel, dataset: tf.data.Dataset<{ xs: tf.Tensor, ys: tf.Tensor }>) {
  const epochs = 50;
  await autoencoder.fitDataset(dataset, {
    epochs,
    callbacks: [tf.callbacks.earlyStopping({ monitor: 'loss', patience: 3 })]
  });
  await autoencoder.save(customIOHandler);
  console.log(`Model saved to ${savedModelDir} with split weight files.`);
}

/**
 * Continue training on new data.
 */
async function continueTrainingOnNewData(newDataDir: string, additionalEpochs: number = 10) {
  const { autoencoder } = await getModel();
  console.log(`Continuing training on new data from ${newDataDir}`);
  const newDataset = createDataset(newDataDir);
  await autoencoder.fitDataset(newDataset, {
    epochs: additionalEpochs,
    callbacks: [tf.callbacks.earlyStopping({ monitor: 'loss', patience: 3 })]
  });
  await autoencoder.save(customIOHandler);
  console.log("Updated model saved after additional training.");
  return autoencoder;
}

/**
 * Helper function to ask a question from the user.
 */
function askUser(query: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

/**
 * Write embeddings to files in chunks.
 */
function writeEmbeddingsInChunks(embeddings: number[][], files: string[], chunkSize: number = 1000) {
  if (!existsSync(embeddingDir)) {
    mkdirSync(embeddingDir);
  }
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunkFiles = files.slice(i, i + chunkSize);
    const chunkEmbeddings = embeddings.slice(i, i + chunkSize);
    chunkFiles.forEach((file, index) => {
      const songId = basename(file, extname(file));
      const output = { songId, embedding: chunkEmbeddings[index], version: EMBEDDING_VERSION };
      const outputString = JSON.stringify(output);
      const filePath = join(embeddingDir, `${songId}_embedding.json`);
      writeFileSync(filePath, outputString, 'utf8');
      console.log(`Embedding for ${songId} saved successfully.`);
    });
  }
}

/**
 * Main execution flow.
 */
(async () => {
  let { autoencoder, encoder } = await getModel();

  if (existsSync(join(savedModelDir, 'model.json'))) {
    const answer = await askUser(
      "Select option:\n  1) Train a new model (discard previous)\n  2) Continue training on previous model\nYour choice: "
    );
    if (answer.trim() === '1') {
      console.log("Deleting previous model and training a new one...");
      rmSync(savedModelDir, { recursive: true, force: true });
      ({ autoencoder, encoder } = buildAutoencoder());
      const initialDataset = createDataset(fvectDir);
      await trainAutoencoder(autoencoder, initialDataset);
    } else if (answer.trim() === '2') {
      console.log("Continuing training on previous model...");
      await continueTrainingOnNewData(fvectDir, 10);
    } else {
      console.log("Invalid selection. Exiting.");
      process.exit(1);
    }
  } else {
    console.log("No previous model found. Starting training.");
    const initialDataset = createDataset(fvectDir);
    await trainAutoencoder(autoencoder, initialDataset);
  }

  // Generate embeddings for all files in the fvect directory.
  const files = readdirSync(fvectDir).filter((file: string) => extname(file) === '.json');
  const embeddings = tf.tidy(() => {
    const allEmbeddings: number[][] = [];
    for (const file of files) {
      const content = JSON.parse(readFileSync(join(fvectDir, file), 'utf8'));
      const vector = content.vector;
      if (vector.length !== inputDim)
        throw new Error("Feature vector at " + file + " has invalid dimensionality: " + vector.length.toString() + "(expected " + inputDim.toString() + ")");
      // const min = Math.min(...vector);
      // const max = Math.max(...vector);
      // const normalizedVector = vector.map((value: number) => (value - min) / (max - min));
      // console.log(content.songId, vector.length)
      const embeddingTensor = encoder.predict(tf.tensor2d([vector])) as tf.Tensor;
      allEmbeddings.push((embeddingTensor.arraySync() as number[][])[0]);
      embeddingTensor.dispose();
    }
    return allEmbeddings;
  });

  writeEmbeddingsInChunks(embeddings, files);
  console.log('Embeddings saved to files in the embeddings directory');
  process.exit(0);
})();
