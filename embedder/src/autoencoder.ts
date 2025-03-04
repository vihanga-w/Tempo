import {
    sequential,
    layers,
    tensor2d,
    callbacks,
    data,
    tidy,
    loadLayersModel,
	Tensor,
	LayersModel
} from '@tensorflow/tfjs-node';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    rmSync
} from 'fs';
import { basename, extname, join } from 'path';
import { createInterface } from 'readline';

export interface EmbeddingOutput {
	songId: string;
	embedding: number[];
}

const inputDim = 41087;
const encodingDim = 4096;

// Directories and paths
const fvectDir = './fvect/';
const embeddingDir = './embeddings/';
const savedModelDir = './saved_autoencoder';
const savedModelPath = `file://${savedModelDir}/model.json`;

/**
 * Builds a new autoencoder (encoder + decoder) and compiles it.
 */
function buildAutoencoder() {
    // Build the encoder.
    const encoder = sequential();
    encoder.add(layers.dense({ inputShape: [inputDim], units: 6828, activation: 'relu' }));
    encoder.add(layers.dense({ units: 4096, activation: 'relu' }));
    encoder.add(layers.dense({ units: 1024, activation: 'relu' }));
    encoder.add(layers.dense({ units: encodingDim, activation: 'relu' }));

    // Build the decoder.
    const decoder = sequential();
    decoder.add(layers.dense({ inputShape: [encodingDim], units: 1024, activation: 'relu' }));
    decoder.add(layers.dense({ units: 4096, activation: 'relu' }));
    decoder.add(layers.dense({ units: 6828, activation: 'relu' }));
    decoder.add(layers.dense({ units: inputDim, activation: 'sigmoid' }));

    // Combine into an autoencoder.
    const autoencoder = sequential();
    autoencoder.add(encoder);
    autoencoder.add(decoder);
    autoencoder.compile({ optimizer: 'adam', loss: 'meanSquaredError' });

    console.log("No previous model found or new model requested. Building a new autoencoder.");
    return { autoencoder, encoder };
}

/**
 * Checks for a saved model. If found, loads it; otherwise returns null.
 * Assumes that the saved autoencoder model has been saved to savedModelDir.
 */
async function loadSavedModel() {
    if (existsSync(`${savedModelDir}/model.json`)) {
        console.log(`Previous model found. Loading model from ${savedModelPath}`);
        const loadedAutoencoder = await loadLayersModel(savedModelPath);
        // Reconstruct the encoder architecture (assumed to be the first layers).
        const encoder = sequential();
        encoder.add(layers.dense({ inputShape: [inputDim], units: 6828, activation: 'relu' }));
        encoder.add(layers.dense({ units: 4096, activation: 'relu' }));
        encoder.add(layers.dense({ units: 1024, activation: 'relu' }));
        encoder.add(layers.dense({ units: encodingDim, activation: 'relu' }));
        // Assume the autoencoder's weights begin with the encoder's weights.
        encoder.setWeights(loadedAutoencoder.getWeights().slice(0, encoder.getWeights().length));
        return { autoencoder: loadedAutoencoder, encoder };
    }
    return null;
}

/**
 * Gets the model to use. If a saved model exists, it is returned.
 * Otherwise, a new model is built.
 */
async function getModel() {
    const saved = await loadSavedModel();
    if (saved) {
        return saved;
    }
    return buildAutoencoder();
}

/**
 * Generator for creating dataset examples from JSON files in a directory.
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
            xs: tensor2d([normalizedVector]),
            ys: tensor2d([normalizedVector])
        };
    }
}

/**
 * Creates a tf.data.Dataset from JSON files in a given directory.
 */
function createDataset(directory: string) {
    return data.generator(() => dataGeneratorFromDir(directory))
        .batch(1)
        .prefetch(1) as data.Dataset<{ xs: Tensor, ys: Tensor }>;
}

/**
 * Trains the autoencoder on the given dataset for a fixed number of epochs
 * and saves the model.
 */
async function trainAutoencoder(
    autoencoder: LayersModel,
    dataset: data.Dataset<{ xs: Tensor, ys: Tensor }>
) {
    const epochs = 50;
    await autoencoder.fitDataset(dataset, {
        epochs,
        callbacks: [callbacks.earlyStopping({ monitor: 'loss', patience: 3 })]
    });
    if (!existsSync(savedModelDir)) {
        mkdirSync(savedModelDir);
    }
    await autoencoder.save(`file://${savedModelDir}`);
    console.log(`Model saved to ${savedModelDir}`);
}

/**
 * Continues training on new data from a given directory.
 */
async function continueTrainingOnNewData(newDataDir: string, additionalEpochs: number = 10) {
    const { autoencoder } = await getModel();
    console.log(`Continuing training on new data from directory: ${newDataDir}`);
    const newDataset = createDataset(newDataDir);
    await autoencoder.fitDataset(newDataset, {
        epochs: additionalEpochs,
        callbacks: [callbacks.earlyStopping({ monitor: 'loss', patience: 3 })]
    });
    await autoencoder.save(`file://${savedModelDir}`);
    console.log(`Updated model saved after training on new data.`);
    return autoencoder;
}

/**
 * Simple helper to ask a question from the user.
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
 * Main execution flow.
 */
(async () => {
    let { autoencoder, encoder } = await getModel();

    // If a saved model exists, present a menu to choose the mode.
    if (existsSync(`${savedModelDir}/model.json`)) {
        const answer = await askUser(
            "Select option:\n  1) Train a new model (discard previous)\n  2) Continue training (add new data) to previous model\nYour choice: "
        );
        if (answer.trim() === '1') {
            console.log("User selected to train a new model. Deleting previous saved model...");
            rmSync(savedModelDir, { recursive: true, force: true });
            ({ autoencoder, encoder } = buildAutoencoder());
            const initialDataset = createDataset(fvectDir);
            console.log("Starting training on new model using dataset from:", fvectDir);
            await trainAutoencoder(autoencoder, initialDataset);
        } else if (answer.trim() === '2') {
            console.log("User selected to continue training on previous model using new data.");
            await continueTrainingOnNewData(fvectDir, 10);
        } else {
            console.log("Invalid selection. Exiting.");
            process.exit(1);
        }
    } else {
        console.log("No previous model found. Starting initial training.");
        const initialDataset = createDataset(fvectDir);
        await trainAutoencoder(autoencoder, initialDataset);
    }

    // Generate embeddings for all files in the initial training directory.
    const files = readdirSync(fvectDir).filter(file => extname(file) === '.json');
    const embeddings = tidy(() => {
        const allEmbeddings: number[][] = [];
        for (const file of files) {
            const content = JSON.parse(readFileSync(join(fvectDir, file), 'utf8'));
            const vector = content.vector.slice(0, inputDim);
            const min = Math.min(...vector);
            const max = Math.max(...vector);
            const normalizedVector = vector.map((value: number) => (value - min) / (max - min));
            const embeddingTensor = encoder.predict(tensor2d([normalizedVector])) as Tensor;
            allEmbeddings.push((embeddingTensor.arraySync() as number[][])[0]);
            embeddingTensor.dispose();
        }
        return allEmbeddings;
    });

    if (!existsSync(embeddingDir)) {
        mkdirSync(embeddingDir);
    }
    files.forEach((file, index) => {
        const songId = basename(file, extname(file));
        const output = { songId, embedding: embeddings[index] };
        writeFileSync(join(embeddingDir, `${songId}_embedding.json`), JSON.stringify(output));
    });
    console.log('Embeddings saved to files in the embeddings directory');
    process.exit(0);
})();