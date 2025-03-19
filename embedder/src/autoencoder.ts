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

const inputDim = 41112;
const encodingDim = 256;
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB

// Directories
const fvectDir = './fvect/';
const embeddingDir = './embeddings/';
const savedModelDir = './saved_autoencoder';

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

    // Return the SaveResult object without the weightSpecs property
    return {
      modelArtifactsInfo: {
        dateSaved: new Date(),
        modelTopologyType: "JSON",
        weightDataBytes: weightArray.byteLength,
        // Removed weightSpecs property
      }
    };
  }
};

/**
 * Build the autoencoder (and encoder) using the functional API.
 */
function buildAutoencoder() {
  const inputLayer = tf.layers.input({ shape: [inputDim] });
  const encoded1 = tf.layers.dense({ units: 12000, activation: 'relu' }).apply(inputLayer) as tf.SymbolicTensor;
  const encoded2 = tf.layers.dense({ units: 5000, activation: 'relu' }).apply(encoded1) as tf.SymbolicTensor;
  const encoded3 = tf.layers.dense({ units: 1024, activation: 'relu' }).apply(encoded2) as tf.SymbolicTensor;
  const encodedOutput = tf.layers.dense({ units: encodingDim, activation: 'relu' }).apply(encoded3) as tf.SymbolicTensor;
  
  const decoded1 = tf.layers.dense({ units: 12000, activation: 'relu' }).apply(encodedOutput) as tf.SymbolicTensor;
  const decoded2 = tf.layers.dense({ units: 5000, activation: 'relu' }).apply(decoded1) as tf.SymbolicTensor;
  const decoded3 = tf.layers.dense({ units: 1024, activation: 'relu' }).apply(decoded2) as tf.SymbolicTensor;
  const decodedOutput = tf.layers.dense({ units: inputDim, activation: 'sigmoid' }).apply(decoded3) as tf.SymbolicTensor;
  
  const autoencoder = tf.model({ inputs: inputLayer, outputs: decodedOutput });
  autoencoder.compile({ optimizer: 'adam', loss: 'meanSquaredError' });
  const encoder = tf.model({ inputs: inputLayer, outputs: encodedOutput });
  console.log("Built a new autoencoder model using the functional API.");
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
    // Rebuild the encoder with the same architecture.
    const inputLayer = tf.layers.input({ shape: [inputDim] });
    const encoded1 = tf.layers.dense({ units: 12000, activation: 'relu' }).apply(inputLayer) as tf.SymbolicTensor;
    const encoded2 = tf.layers.dense({ units: 5000, activation: 'relu' }).apply(encoded1) as tf.SymbolicTensor;
    const encoded3 = tf.layers.dense({ units: 1024, activation: 'relu' }).apply(encoded2) as tf.SymbolicTensor;
    const encodedOutput = tf.layers.dense({ units: encodingDim, activation: 'relu' }).apply(encoded3) as tf.SymbolicTensor;
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

/**
 * Generator to create dataset examples from JSON files.
 */
function* dataGeneratorFromDir(directory: string) {
  const files = readdirSync(directory).filter(file => extname(file) === '.json');
  for (const file of files) {
    const content = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const vector = content.vector.slice(0, inputDim);
    const min = Math.min(...vector);
    const max = Math.max(...vector);
    const normalizedVector = vector.map((value: number) => (value - min) / (max - min));
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
      const output = { songId, embedding: chunkEmbeddings[index] };
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
      const vector = content.vector.slice(0, inputDim);
      const min = Math.min(...vector);
      const max = Math.max(...vector);
      const normalizedVector = vector.map((value: number) => (value - min) / (max - min));
      const embeddingTensor = encoder.predict(tf.tensor2d([normalizedVector])) as tf.Tensor;
      allEmbeddings.push((embeddingTensor.arraySync() as number[][])[0]);
      embeddingTensor.dispose();
    }
    return allEmbeddings;
  });

  writeEmbeddingsInChunks(embeddings, files);
  console.log('Embeddings saved to files in the embeddings directory');
  process.exit(0);
})();
