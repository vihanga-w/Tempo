#!/bin/bash

set -e

COMMAND=$1
ARGUMENT=$2

if [ -z "$COMMAND" ]; then
    echo "No command provided."
    echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader|copy-trusted-keys]"
    exit 1
fi

copy_trusted_keys() {
    echo "Copying trusted public keys..."

    # Paths
    KEYS_DIR="./tempodb/keys"
    TRUSTED_KEYS_DIR="./tempodb/trusted-keys"

    if [ ! -d "$KEYS_DIR" ]; then
        echo "Keys directory does not exist: $KEYS_DIR"
        return
    fi

    mkdir -p "$TRUSTED_KEYS_DIR"

    PUBLIC_KEYS=("$KEYS_DIR"/.public*.key.pem)

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
        echo "Stopping TempoDB cluster (proxy, node1, node2, node3)..."
        sudo docker-compose stop proxy node1 node2 node3
        sudo docker-compose rm -f proxy node1 node2 node3
        ;;
    
    rebuild)
        echo "Rebuilding project..."
        pnpm run build
        echo "Copying trusted keys..."
        copy_trusted_keys
        echo "Restarting Docker containers..."
        sudo docker-compose stop proxy node1 node2 node3
        sudo docker-compose rm -f proxy node1 node2 node3
        sudo docker-compose up --build -d
        ;;
    
    status)
        echo "Cluster status:"
        sudo docker-compose ps
        ;;
    
    logs)
        echo "Showing cluster logs (proxy, node1, node2, node3):"
        sudo docker-compose logs --follow --tail=100 proxy node1 node2 node3
        ;;
    
    restart-node)
        if [ -z "$ARGUMENT" ]; then
            echo "No node specified. Usage: ./tempodb restart-node <node>"
            exit 1
        fi
        echo "Restarting node: $ARGUMENT"
        sudo docker-compose restart $ARGUMENT
        ;;
    
    get-leader)
        echo "Querying current leader..."
        curl -s http://localhost:2275/raft/leader | jq .
        ;;

    copy-trusted-keys)
        copy_trusted_keys
        ;;

    *)
        echo "Unknown command: $COMMAND"
        echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader|copy-trusted-keys]"
        exit 1
        ;;
esac