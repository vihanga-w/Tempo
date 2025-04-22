import os
import json
import random
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics.pairwise import euclidean_distances
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.spatial import ConvexHull
from matplotlib.widgets import CheckButtons

# === Paths & Configuration ===
EMBEDDING_DIR = "embeddings"
CONFIG_PATH = "config.json"
CLUSTERED_PATH = "clustered_embeddings.csv"
LABELS_PATH = "cluster_labels.json"
CENTROIDS_PATH = "cluster_centroids.npy"

default_config = {
    "FINAL_K": 8,
    "SAMPLE_SIZE": 5,
    "VERBOSE": True,
    "DISTANCE_THRESHOLD": 8.5
}

def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w") as f:
            json.dump(default_config, f, indent=2)
        print("Created configuration file: config.json")
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

config = load_config()

def log(message):
    if config.get("VERBOSE", False):
        print(f"[log] {message}")

def get_cluster_labels():
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH, "r") as f:
            return json.load(f)
    return {}

def flag_multi_group_entries(df):
    """Adds a boolean column 'multi_group' to indicate entries with duplicate songId."""
    counts = df["songId"].value_counts()
    df["multi_group"] = df["songId"].map(lambda sid: counts[sid] > 1)
    return df

def load_clustered_data():
    if not os.path.exists(CLUSTERED_PATH):
        log("Clustered embedding dataset not found.")
        return None, None

    log("Loading clustered embedding metadata...")
    df = pd.read_csv(CLUSTERED_PATH, dtype={"cluster": object})

    df["cluster"] = df["cluster"].apply(lambda x: json.loads(x) if isinstance(x, str) else x)

    embeddings = []
    for song_id in df["songId"]:
        path = os.path.join(EMBEDDING_DIR, f"{song_id}_embedding.json")
        if os.path.exists(path):
            with open(path, "r") as f:
                data = json.load(f)
                embeddings.append(data["embedding"])
        else:
            print(f"[warning] Embedding file missing for songId: {song_id}")
            if embeddings:
                embeddings.append([0] * len(embeddings[0]))
            else:
                embeddings.append([0])  # fallback

    log(f"Restored {len(df)} clustered records with {len(embeddings[0])}-dimensional vectors.")
    return df, np.array(embeddings)

def load_embeddings():
    print("Scanning embedding directory...")
    embedding_data = []
    file_list = [f for f in os.listdir(EMBEDDING_DIR) if f.endswith(".json")]

    for i, filename in enumerate(file_list):
        if i % 500 == 0:
            print(f"  Processed {i + 1}/{len(file_list)} files")
        with open(os.path.join(EMBEDDING_DIR, filename), "r") as f:
            data = json.load(f)
            embedding_data.append({
                "songId": data["songId"],
                "embedding": data["embedding"]
            })

    df = pd.DataFrame(embedding_data)
    print(f"Loaded {len(df)} embedding vectors.")
    return df, np.vstack(df["embedding"].values)

def run_elbow(embeddings):
    print("\nExecuting elbow curve analysis...")
    inertias = []

    for k in range(2, 32):
        log(f"Evaluating KMeans with k={k}")
        kmeans = KMeans(n_clusters=k, random_state=42, n_init="auto")
        kmeans.fit(embeddings)
        inertias.append(kmeans.inertia_)

    plt.figure(figsize=(10, 5))
    plt.plot(range(2, 32), inertias, marker='o')
    plt.xlabel("Cluster Count (k)")
    plt.ylabel("Inertia (within-cluster sum of squares)")
    plt.title("Elbow Curve for KMeans Optimization")
    plt.grid(True)
    plt.tight_layout()
    plt.savefig("elbow_plot.png")
    print("Elbow plot saved to 'elbow_plot.png'.")
    plt.show()

def run_clustering(df, embeddings, k):
    print(f"\nPerforming KMeans clustering with k={k}...")
    kmeans = KMeans(n_clusters=k, random_state=42, n_init="auto")
    kmeans.fit(embeddings)

    centroids = kmeans.cluster_centers_
    distances = euclidean_distances(embeddings, centroids)

    # Configurable threshold: assign all clusters within X% of the closest
    RELATIVE_THRESHOLD = 1.15  # e.g., 15% farther than best match

    soft_clusters = []
    for dists in distances:
        min_dist = dists.min()
        assigned = [i for i, dist in enumerate(dists) if dist <= min_dist * RELATIVE_THRESHOLD]
        soft_clusters.append(assigned)

    df["cluster"] = soft_clusters

    # Save stringified
    df_to_save = df.copy()
    df_to_save["cluster"] = df_to_save["cluster"].apply(json.dumps)
    df_to_save.to_csv(CLUSTERED_PATH, index=False)
    np.save(CENTROIDS_PATH, centroids)

    print(f"Soft clustering complete. Songs assigned to ~{np.mean([len(c) for c in soft_clusters]):.2f} clusters on average.")
    return df

def append_new_embeddings(new_df, new_embeddings):
    if not os.path.exists(CENTROIDS_PATH):
        print("[error] Centroid matrix not found. Initial clustering must be performed first.")
        return

    centroids = np.load(CENTROIDS_PATH)
    distances = euclidean_distances(new_embeddings, centroids)

    RELATIVE_THRESHOLD = 1.15  # reuse same logic
    soft_clusters = []
    for dists in distances:
        min_dist = dists.min()
        assigned = [i for i, dist in enumerate(dists) if dist <= min_dist * RELATIVE_THRESHOLD]
        soft_clusters.append(assigned if assigned else [-1])

    new_df["cluster"] = soft_clusters

    # Save
    new_df["cluster"] = new_df["cluster"].apply(json.dumps)
    existing_df = pd.read_csv(CLUSTERED_PATH) if os.path.exists(CLUSTERED_PATH) else pd.DataFrame()
    updated_df = pd.concat([existing_df, new_df], ignore_index=True)
    updated_df.to_csv(CLUSTERED_PATH, index=False)

    print(f"{len(new_df)} new embeddings assigned to one or more clusters.")

# === Labeling & Visualization ===
def label_clusters(df):
    print("\n=== Cluster Labeling Interface ===")
    labels = get_cluster_labels()
    
    all_clusters = sorted(set(c for clusters in df["cluster"] for c in clusters))

    for cluster_id in all_clusters:
        if cluster_id == -1:
            continue  # Skip unassigned
        str_id = str(cluster_id)
        if str_id in labels:
            print(f"Cluster {cluster_id} [label: '{labels[str_id]}'] already labeled. Skipping.")
            continue

        print(f"\nAssigning label for cluster {cluster_id}")
        sample_ids = df[df["cluster"] == cluster_id]["songId"].drop_duplicates().sample(n=5, replace=False)
        for song_id in sample_ids:
            print(f"  • {song_id}")

        label = input("Enter descriptive label (or leave blank to skip): ").strip()
        if label:
            labels[str_id] = label
            with open(LABELS_PATH, "w") as f:
                json.dump(labels, f, indent=2)
            print(f"Saved label '{label}' for cluster {cluster_id}")
        else:
            print("No label assigned.")

def sample_clusters(df, sample_size):
    print("\n=== Cluster Sampling ===")
    labels = get_cluster_labels()
    
    all_clusters = sorted(set(c for clusters in df["cluster"] for c in clusters))

    for cluster_id in all_clusters:
        if cluster_id == -1:
            continue
        label = labels.get(str(cluster_id), "Unlabeled")
        print(f"\nCluster {cluster_id} ({label}):")
        cluster_songs = df[df["cluster"] == cluster_id]["songId"].drop_duplicates()
        sample = cluster_songs.sample(min(sample_size, len(cluster_songs)))
        for song_id in sample:
            print(f"  • {song_id}")

def visualize_clusters(df, embeddings):
    print("\nRendering PCA projection with enhanced cluster overlays...")
    labels = get_cluster_labels()

    # Remove entries with [-1] in cluster
    valid_mask = df["cluster"].apply(lambda clusters: -1 not in clusters)
    df = df[valid_mask].copy()
    embeddings = embeddings[valid_mask.values]

    if embeddings is None or len(embeddings) != len(df):
        print("[warning] PCA skipped: embeddings mismatch.")
        return

    # PCA to 2D
    pca = PCA(n_components=2)
    reduced = pca.fit_transform(embeddings)
    df["pca_x"] = reduced[:, 0]
    df["pca_y"] = reduced[:, 1]

    # Outlier filtering
    y_threshold = np.percentile(df["pca_y"], 99.5)
    df = df[df["pca_y"] < y_threshold]

    # Confidence (inverse of distance if available)
    df["confidence"] = df["distance"].apply(lambda d: 1 / (d + 1e-5)) if "distance" in df.columns else 1.0

    # Compute multi-group membership before caching
    df["multi_group"] = df["songId"].duplicated(keep=False)

    # Prepare clusters
    clusters = sorted(set(c for cluster_list in df["cluster"] for c in cluster_list))
    palette = sns.color_palette("tab10", n_colors=len(clusters))

    fig, ax = plt.subplots(figsize=(12, 7))
    plt.subplots_adjust(left=0.25, right=0.85)

    cluster_artists = {}
    checkbox_labels = []
    cluster_data_cache = {}

    for idx, cluster_id in enumerate(clusters):
        cluster_df = df[df["cluster"].apply(lambda clusters: cluster_id in clusters)].copy()
        cluster_data_cache[cluster_id] = cluster_df  # store full version for toggling

        cluster_points = cluster_df[["pca_x", "pca_y"]].values
        color = palette[idx % len(palette)]
        label = labels.get(str(cluster_id), "Unlabeled")

        display_name = f"{cluster_id}: {label}"
        checkbox_labels.append(display_name)

        sizes = cluster_df["confidence"].clip(0.2, 1.5) * 40

        points = ax.scatter(cluster_points[:, 0], cluster_points[:, 1],
                            s=sizes, alpha=0.75, edgecolors="black", color=color)

        patch = None
        if len(cluster_points) >= 3:
            try:
                hull = ConvexHull(cluster_points)
                hull_pts = cluster_points[hull.vertices]
                patch = plt.Polygon(hull_pts, alpha=0.15, color=color, edgecolor="black", linewidth=1.5)
                ax.add_patch(patch)
            except:
                pass

        center_x = cluster_points[:, 0].mean()
        center_y = cluster_points[:, 1].mean()
        text = ax.text(center_x, center_y, label, fontsize=9, weight="bold", ha="center", va="center",
                       bbox=dict(facecolor="white", alpha=0.6, boxstyle="round,pad=0.3"))

        cluster_artists[display_name] = [points, patch, text]

    ax.set_title("Cluster Distribution (PCA Projection)")
    ax.set_xlabel("Principal Component 1")
    ax.set_ylabel("Principal Component 2")

    # Checkbox UI
    rax = plt.axes([0.88, 0.2, 0.1, 0.6])
    visibility = [True] * len(checkbox_labels)
    check = CheckButtons(rax, checkbox_labels, visibility)

    for label_text, label in zip(checkbox_labels, check.labels):
        cluster_id = int(label_text.split(":")[0])
        color = palette[clusters.index(cluster_id) % len(palette)]
        label.set_color(color)
        label.set_fontsize(9)

    def toggle(label_text):
        artists = cluster_artists.get(label_text)
        if artists:
            for artist in artists:
                if artist:
                    artist.set_visible(not artist.get_visible())
        plt.draw()

    check.on_clicked(toggle)

    # === Multi-group Toggle ===
    multi_group_mode = {"enabled": False}

    def toggle_multi_group(event=None):
        multi_group_mode["enabled"] = not multi_group_mode["enabled"]

        for label_text, artists in cluster_artists.items():
            cluster_id = int(label_text.split(":")[0])
            full_df = cluster_data_cache[cluster_id]
            cluster_df = full_df[full_df["multi_group"]] if multi_group_mode["enabled"] else full_df

            cluster_points = cluster_df[["pca_x", "pca_y"]].values
            sizes = cluster_df["confidence"].clip(0.2, 1.5) * 40

            if len(cluster_points) == 0:
                artists[0].set_offsets(np.empty((0, 2)))  # avoids IndexError
                artists[0].set_visible(False)
                if artists[1]: artists[1].set_visible(False)
                if artists[2]: artists[2].set_visible(False)
                continue

            artists[0].set_offsets(cluster_points)
            artists[0].set_sizes(sizes)
            artists[0].set_visible(True)

            if artists[1]:  # convex hull
                try:
                    hull = ConvexHull(cluster_points)
                    hull_pts = cluster_points[hull.vertices]
                    artists[1].set_xy(hull_pts)
                    artists[1].set_visible(True)
                except:
                    artists[1].set_visible(False)

            artists[2].set_position((cluster_points[:, 0].mean(), cluster_points[:, 1].mean()))
            artists[2].set_visible(True)

        plt.draw()

    # Button
    from matplotlib.widgets import Button
    bax = plt.axes([0.88, 0.85, 0.1, 0.05])
    bfilter = Button(bax, "Show Multi-group")
    bfilter.on_clicked(toggle_multi_group)

    plt.show()

# === Config Editing ===
def edit_config():
    print("\n--- Modify Configuration Parameters ---")
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)

    for key in config:
        current_value = config[key]
        new_value = input(f"{key} (current: {current_value}) → ").strip()
        if new_value != "":
            try:
                config[key] = int(new_value)
            except ValueError:
                print("Invalid input. Must be a numeric value.")

    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)

    print("Configuration updated.")
    return config

def reset_config():
    confirm = input("Confirm reset of configuration to default values? (y/n): ").strip().lower()
    if confirm == "y":
        with open(CONFIG_PATH, "w") as f:
            json.dump(default_config, f, indent=2)
        print("Configuration reset to factory defaults.")
    else:
        print("Operation cancelled.")
    return default_config

def export_clusters_to_json():
    print("\nExporting cluster metadata to JSON...")

    if not os.path.exists(CLUSTERED_PATH):
        print("Clustered dataset not found.")
        return

    df = pd.read_csv(CLUSTERED_PATH)
    labels = get_cluster_labels()
    centroids = np.load(CENTROIDS_PATH) if os.path.exists(CENTROIDS_PATH) else None

    clusters = []
    
    all_clusters = sorted(set(c for clusters in df["cluster"] for c in clusters))

    for cluster_id in all_clusters:
        if cluster_id == -1:
            continue
        cluster_df = df[df["cluster"].apply(lambda clusters: cluster_id in clusters)]
        label = labels.get(str(cluster_id), None)

        group = {
            "cluster_id": int(cluster_id),
            "label": label,
            "song_count": cluster_df["songId"].nunique(),
            "members": []
        }

        for _, row in cluster_df.iterrows():
            group["members"].append({
                "songId": row["songId"],
                "distance": float(row.get("distance", -1))
            })

        if centroids is not None:
            group["centroid"] = centroids[cluster_id].tolist()

        clusters.append(group)

    export = {
        "total_clusters": len(clusters),
        "clusters": clusters
    }

    with open("clusters_export.json", "w") as f:
        json.dump(export, f, indent=2)

    print("Export complete: clusters_export.json")

# === Main Menu ===
def main_menu():
    config = load_config()
    df, embeddings = load_clustered_data()

    while True:
        print("\n=== Tempo Embedding Clustering Tool ===")
        print("0. Modify configuration parameters")
        print("1. Load embedding dataset")
        print("2. Run elbow method analysis")
        print("3. Perform clustering")
        print("4. Visualize clusters (PCA projection)")
        print("5. Sample tracks per cluster")
        print("6. Assign mood labels to clusters")
        print("8. Append new embeddings to existing clusters")
        print("9. Reset configuration to defaults")
        print("10. Export cluster metadata to JSON")
        print("7. Exit")

        choice = input("Select an operation: ").strip()

        if choice == "0":
            config = edit_config()
        elif choice == "9":
            config = reset_config()
        elif choice == "10":
            export_clusters_to_json()
        elif choice == "1":
            df, embeddings = load_embeddings()
        elif choice == "2":
            if embeddings is None:
                print("Embedding dataset not loaded.")
            else:
                run_elbow(embeddings)
        elif choice == "3":
            if embeddings is None:
                print("Embedding dataset not loaded.")
            else:
                df = run_clustering(df, embeddings, config["FINAL_K"])
                df = flag_multi_group_entries(df)
        elif choice == "4":
            if df is None or "cluster" not in df:
                print("No cluster assignments available.")
            else:
                df = flag_multi_group_entries(df)
                visualize_clusters(df, embeddings)
        elif choice == "5":
            if df is None or "cluster" not in df:
                print("No cluster assignments available.")
            else:
                sample_clusters(df, config["SAMPLE_SIZE"])
        elif choice == "6":
            if df is None and os.path.exists(CLUSTERED_PATH):
                df = pd.read_csv(CLUSTERED_PATH)
            if df is None or "cluster" not in df:
                print("No cluster assignments available.")
            else:
                label_clusters(df)
        elif choice == "8":
            new_df, new_embeddings = load_embeddings()
            existing_df = pd.read_csv(CLUSTERED_PATH) if os.path.exists(CLUSTERED_PATH) else pd.DataFrame()
            existing_song_ids = set(existing_df["songId"]) if not existing_df.empty else set()
            unclustered_mask = [sid not in existing_song_ids for sid in new_df["songId"]]
            filtered_df = new_df[unclustered_mask]
            filtered_embeddings = new_embeddings[unclustered_mask]
            if len(filtered_df) > 0:
                append_new_embeddings(filtered_df, filtered_embeddings)
            else:
                print("No new embeddings detected for clustering.")
        elif choice == "7":
            print("Session terminated.")
            break
        else:
            print("Unrecognized option.")

if __name__ == "__main__":
    main_menu()