echo "[1] Preparing the environment"
source ~/.nvm/nvm.sh
cd node
npm rebuild @tensorflow/tfjs-node --build-addon-from-source
npx tsc
cd ../pypkg
source venv/bin/activate
cd ..

echo "[2] Extracting audio features"
python3 -m pypkg.extract

echo "[3] Creating feature vectors"
node ./node/build/process/node/process.js

echo "[4] Training the model"
node ./node/build/process/node/autoencoder.js

echo "Pipeline complete! Check above for any errors, otherwise check ./embeddings for the results."