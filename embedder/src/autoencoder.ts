import * as tf from '@tensorflow/tfjs-node';
import * as fs from 'fs';
import * as path from 'path';

const inputDim = 8219; // Updated input dimension
const encodingDim = 128; // Dimension of the encoding space

export interface EmbeddingOutput {
	songId: string;
	embedding: number[];
}

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

async function trainAutoencoder(data: tf.Tensor) {
	const epochs = 50;
	const batchSize = 32;

	// Ensure the input data is reshaped to match the input dimension
	if (data.shape[1] !== inputDim) {
		throw new Error(`Input data must have ${inputDim} features, but has ${data.shape[1]}`);
	}

	const reshapedData = data.reshape([-1, inputDim]);

	console.log(`Reshaped data dimensions: ${reshapedData.shape}`);

	await autoencoder.fit(reshapedData, reshapedData, {
		epochs,
		batchSize,
		validationSplit: 0.2,
		callbacks: tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 5 })
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
	return vector.map((value: number) => (value - min) / (max - min));
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
	const embeddings = encoderModel.predict(X) as tf.Tensor;
	const embeddingArray = embeddings.arraySync() as number[][];

	if (!fs.existsSync(embeddingDir)) {
		fs.mkdirSync(embeddingDir);
	}

	files.forEach((file, index) => {
		const songId = path.basename(file, path.extname(file));
		const output: EmbeddingOutput = {
			songId: songId,
			embedding: embeddingArray[index]
		};
		fs.writeFileSync(path.join(embeddingDir, `${songId}_embedding.json`), JSON.stringify(output));
	});

	console.log('Embeddings saved to files in the embeddings directory');
});
