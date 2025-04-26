import os
import concurrent.futures
import time
from tqdm import tqdm
from datetime import datetime, timedelta
from .fext import extract_feature

def process_file(filepath):
    extract_feature(filepath)

def process_all_sources_parallel():
    sources_dir = "./sources"
    files = [os.path.join(sources_dir, f) for f in os.listdir(sources_dir) if f.endswith(".wav")]

    max_workers = os.cpu_count() - 1 if os.cpu_count() > 1 else 1
    total_files = len(files)
    rolling_eta = None
    rolling_fps = None
    alpha = 0.2  # weight for rolling average

    with concurrent.futures.ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_file, filepath): filepath for filepath in files}

        with tqdm(total=total_files, desc="Extracting", unit="file") as pbar:
            start_time = time.time()
            completed = 0

            for future in concurrent.futures.as_completed(futures):
                completed += 1
                elapsed = time.time() - start_time
                rate = elapsed / completed if completed > 0 else 0
                fps = 1 / rate if rate > 0 else 0
                remaining = total_files - completed
                eta = remaining * rate

                if rolling_eta is None:
                    rolling_eta = eta
                    rolling_fps = fps
                else:
                    rolling_eta = alpha * eta + (1 - alpha) * rolling_eta
                    rolling_fps = alpha * fps + (1 - alpha) * rolling_fps

                finish_time = datetime.now() + timedelta(seconds=rolling_eta)
                finish_str = finish_time.strftime('%H:%M:%S')

                pbar.set_postfix(eta=f"{int(rolling_eta)}s", finish=finish_str)
                pbar.update(1)

if __name__ == "__main__":
    process_all_sources_parallel()