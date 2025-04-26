#!/bin/bash

set -e

COMMAND=$1
ARGUMENT=$2

TRUSTED_KEYS_DIR="./tempodb/trusted-keys"
TRUSTED_PROXY_KEYS_DIR="./tempodb/trusted-proxy-keys"
KEYS_DIR="./tempodb/keys"

function ensure_tempodb_structure() {
    echo "Checking /tempodb/ structure..."

    mkdir -p ./tempodb

    if [ ! -d "$KEYS_DIR" ]; then
        echo "Creating keys directory..."
        mkdir -p "$KEYS_DIR"
    fi

    if [ ! -d "$TRUSTED_KEYS_DIR" ]; then
        echo "Creating trusted-keys directory..."
        mkdir -p "$TRUSTED_KEYS_DIR"
    fi

    if [ ! -d "$TRUSTED_PROXY_KEYS_DIR" ]; then
        echo "Creating trusted-proxy-keys directory..."
        mkdir -p "$TRUSTED_PROXY_KEYS_DIR"
    fi
}

if [ -z "$COMMAND" ]; then
    echo "No command provided."
    echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader]"
    exit 1
fi

case $COMMAND in
    start)
        ensure_tempodb_structure
        echo "Building project..."
        pnpm run build
        echo "Starting TempoDB cluster..."
        sudo docker-compose up --build -d
        ;;
    
    stop)
        echo "Stopping TempoDB cluster (proxy, node1, node2, node3)..."
        sudo docker-compose stop proxy node1 node2 node3
        sudo docker-compose rm -f proxy node1 node2 node3
        ;;
    
    rebuild)
        ensure_tempodb_structure
        echo "Rebuilding project..."
        pnpm run build
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
        curl -s http://localhost:2276/raft/leader | jq .
        ;;
    
    *)
        echo "Unknown command: $COMMAND"
        echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader]"
        exit 1
        ;;
esac