#!/bin/bash

set -e

COMMAND=$1
ARGUMENT=$2

NODES=("node1" "node2" "node3")
ALL_CONTAINERS=("proxy" "node1" "node2" "node3")

if [ -z "$COMMAND" ]; then
    echo "No command provided."
    echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader|copy-trusted-keys|extract-public-keys|sync-trusted-keys|inspect-node]"
    exit 1
fi

copy_trusted_keys() {
    echo "Copying trusted public keys..."

    local KEYS_DIR="./tempodb/keys"
    local TRUSTED_KEYS_DIR="./tempodb/trusted-keys"

    if [ ! -d "$KEYS_DIR" ]; then
        echo "Keys directory does not exist: $KEYS_DIR"
        return
    fi

    mkdir -p "$TRUSTED_KEYS_DIR"

    local PUBLIC_KEYS=("$KEYS_DIR"/.public*.key.pem)

    if [ ! -e "${PUBLIC_KEYS[0]}" ]; then
        echo "No public keys found to copy. Skipping."
        return
    fi

    for pubkey in "${PUBLIC_KEYS[@]}"; do
        cp "$pubkey" "$TRUSTED_KEYS_DIR/"
        echo "Copied trusted key: $(basename "$pubkey")"
    done

    echo "Trusted keys copy complete."
}

extract_public_keys() {
    echo "Extracting public keys from cluster nodes..."

    OUTPUT_DIR="./extracted-keys"
    mkdir -p "$OUTPUT_DIR"

    for NODE in "${NODES[@]}"; do
        [ "$NODE" == "proxy" ] && continue  # Skip proxy

        echo "Extracting from $NODE..."

        LOCAL_NODE_DIR="$OUTPUT_DIR/$NODE"
        mkdir -p "$LOCAL_NODE_DIR"

        echo "Checking files inside $NODE before copying..."
        sudo docker-compose exec "$NODE" ls -la /tempodb/keys || echo "Failed to list /tempodb/keys"

        CONTAINER_ID=$(sudo docker-compose ps -q "$NODE")
        if [ -z "$CONTAINER_ID" ]; then
            echo "Error: Could not find running container for $NODE"
            continue
        fi

        # Find all public keys
        PUB_KEYS=$(sudo docker-compose exec "$NODE" sh -c "ls /tempodb/keys/.public*.key.pem 2>/dev/null" || true)

        if [ -z "$PUB_KEYS" ]; then
            echo "Warning: No public keys found in $NODE."
            continue
        fi

        for KEY_PATH in $PUB_KEYS; do
            BASENAME=$(basename "$KEY_PATH")
            if sudo docker cp "$CONTAINER_ID:/tempodb/keys/$BASENAME" "$LOCAL_NODE_DIR/"; then
                echo "Copied $BASENAME from $NODE to $LOCAL_NODE_DIR"
            else
                echo "Failed to copy $BASENAME from $NODE"
            fi
        done
    done

    echo "Extraction complete. Keys are saved under $OUTPUT_DIR/"
}

sync_trusted_keys() {
    echo "Syncing extracted public keys into ./trusted-keys/..."

    local TRUSTED_KEYS_DIR="./trusted-keys"
    mkdir -p "$TRUSTED_KEYS_DIR"

    if [ ! -d "./extracted-keys" ]; then
        echo "No extracted keys directory found."
        exit 1
    fi

    for node_dir in ./extracted-keys/*/; do
        node_name=$(basename "$node_dir")
        for pubkey in "$node_dir"/.public*.key.pem; do
            if [ -f "$pubkey" ]; then
                base_key_name=$(basename "$pubkey")
                new_key_name="${node_name}-${base_key_name}"
                cp "$pubkey" "$TRUSTED_KEYS_DIR/$new_key_name"
                echo "Copied $(basename "$pubkey") as $new_key_name"
            else
                echo "No public keys found in $node_dir"
            fi
        done
    done

    echo "Trusted keys synced successfully into $TRUSTED_KEYS_DIR/"
}

inspect_node() {
    if [ -z "$ARGUMENT" ]; then
        echo "No node specified. Usage: ./tempodb inspect-node <node>"
        exit 1
    fi

    echo "Opening shell inside container: $ARGUMENT"
    sudo docker-compose exec "$ARGUMENT" /bin/sh
}

case $COMMAND in
    start)
        echo "Building project..."
        pnpm run build
        echo "Copying trusted keys..."
        copy_trusted_keys
        echo "Starting TempoDB cluster..."
        sudo docker-compose up --build -d
        ;;
    
    stop)
        echo "Stopping TempoDB cluster..."
        for CONTAINER in "${ALL_CONTAINERS[@]}"; do
            sudo docker-compose stop "$CONTAINER" || true
            sudo docker-compose rm -f "$CONTAINER" || true
        done
        ;;
    
    rebuild)
        echo "Rebuilding project..."
        pnpm run build
        echo "Copying trusted keys..."
        copy_trusted_keys
        echo "Restarting Docker containers..."
        for CONTAINER in "${ALL_CONTAINERS[@]}"; do
            sudo docker-compose stop "$CONTAINER" || true
            sudo docker-compose rm -f "$CONTAINER" || true
        done
        sudo docker-compose up --build -d
        ;;
    
    status)
        echo "Cluster status:"
        sudo docker-compose ps
        ;;
    
    logs)
        echo "Showing cluster logs (proxy, node1, node2, node3):"
        sudo docker-compose logs --follow --tail=100 "${ALL_CONTAINERS[@]}"
        ;;
    
    restart-node)
        if [ -z "$ARGUMENT" ]; then
            echo "No node specified. Usage: ./tempodb restart-node <node>"
            exit 1
        fi
        echo "Restarting node: $ARGUMENT"
        sudo docker-compose restart "$ARGUMENT"
        ;;
    
    get-leader)
        echo "Querying current leader..."
        curl -s http://localhost:2275/raft/leader | jq .
        ;;
    
    copy-trusted-keys)
        copy_trusted_keys
        ;;

    extract-public-keys)
        extract_public_keys
        ;;

    sync-trusted-keys)
        sync_trusted_keys
        ;;

    inspect-node)
        inspect_node
        ;;

    *)
        echo "Unknown command: $COMMAND"
        echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader|copy-trusted-keys|extract-public-keys|sync-trusted-keys|inspect-node]"
        exit 1
        ;;
esac
