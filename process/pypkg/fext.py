import json
import os
import librosa
import numpy as np
import logging
import time
import traceback

# Logger setup
logger = logging.getLogger("feature_extractor")
logger.setLevel(logging.INFO)
file_handler = logging.FileHandler("feature_extraction.log")
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(file_handler)

def enable_console_logging():
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(stream_handler)

def stats(x):
    return float(np.mean(x)), float(np.std(x)), float(np.var(x))

def extract_feature(path, verbose=False):
    if verbose:
        enable_console_logging()

    start_time = time.perf_counter()
    logger.info(f"Starting feature extraction for: {path}")
    logger.info(f"File path: {os.path.abspath(path)}")

    try:
        song_name = os.path.basename(path)

        y, sr = librosa.load(path, sr=22050, duration=30, dtype=np.float32)

        logger.info(f"Extracting features for: {path}")

        # Extract features directly without precomputing S
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
        chroma_stft = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_cq = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_cens = librosa.feature.chroma_cens(y=y, sr=sr)
        melspectrogram = librosa.feature.melspectrogram(y=y, sr=sr)
        rms = librosa.feature.rms(y=y)
        cent = librosa.feature.spectral_centroid(y=y, sr=sr)
        spec_bw = librosa.feature.spectral_bandwidth(y=y, sr=sr)
        contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)
        poly_features = librosa.feature.poly_features(y=y, sr=sr)
        tonnetz = librosa.feature.tonnetz(y=y, sr=sr)
        zcr = librosa.feature.zero_crossing_rate(y)
        harmonic = librosa.effects.harmonic(y)
        percussive = librosa.effects.percussive(y)
        mfcc = librosa.feature.mfcc(y=y, sr=sr)
        mfcc_delta = librosa.feature.delta(mfcc)
        frames_to_time = librosa.frames_to_time(librosa.onset.onset_detect(y=y, sr=sr)[:20], sr=sr)

        logger.info(f"Calculating statistics for: {path}")

        features = {
            "song_name": song_name,
            "tempo": float(tempo),
            "total_beats": int(sum(beats)),
            "average_beats": float(np.average(beats)) if len(beats) > 0 else 0.0,
        }

        def add_stats(name, array):
            mean, std, var = stats(array)
            features[f"{name}_mean"] = mean
            features[f"{name}_std"] = std
            features[f"{name}_var"] = var

        # Add all feature stats
        add_stats("chroma_stft", chroma_stft)
        add_stats("chroma_cq", chroma_cq)
        add_stats("chroma_cens", chroma_cens)
        add_stats("melspectrogram", melspectrogram)
        add_stats("mfcc", mfcc)
        add_stats("mfcc_delta", mfcc_delta)
        add_stats("rms", rms)
        add_stats("cent", cent)
        add_stats("spec_bw", spec_bw)
        add_stats("contrast", contrast)
        add_stats("rolloff", rolloff)
        add_stats("poly", poly_features)
        add_stats("tonnetz", tonnetz)
        add_stats("zcr", zcr)
        add_stats("harm", harmonic)
        add_stats("perc", percussive)
        add_stats("frame", frames_to_time)

        os.makedirs("fext", exist_ok=True)
        filename = os.path.join("fext", song_name + ".json")

        with open(filename, "w") as f:
            json.dump(features, f, indent=4)

        elapsed = time.perf_counter() - start_time
        logger.info(f"Feature extraction complete for file: {path} in {elapsed:.2f} seconds.")
        logger.info(f"Saved to {filename}")

    except Exception:
        logger.error(f"Failed to extract features for file: {path}.")
        logger.error(traceback.format_exc())