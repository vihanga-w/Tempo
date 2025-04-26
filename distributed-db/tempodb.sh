#!/bin/bash

set -e

COMMAND=$1
ARGUMENT=$2

if [ -z "$COMMAND" ]; then
    echo "No command provided."
    echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader]"
    exit 1
fi

case $COMMAND in
    start)
        echo "Building project..."
        pnpm run build
        echo "Starting TempoDB cluster..."
        docker-compose up --build -d
        ;;
    
    stop)
        echo "Stopping TempoDB cluster (proxy, node1, node2, node3)..."
        docker-compose stop proxy node1 node2 node3
        docker-compose rm -f proxy node1 node2 node3
        ;;
    
    rebuild)
        echo "Rebuilding project..."
        pnpm run build
        echo "Restarting Docker containers..."
        docker-compose stop proxy node1 node2 node3
        docker-compose rm -f proxy node1 node2 node3
        docker-compose up --build -d
        ;;
    
    status)
        echo "Cluster status:"
        docker-compose ps
        ;;
    
    logs)
        echo "Showing cluster logs (proxy, node1, node2, node3):"
        docker-compose logs --follow --tail=100 proxy node1 node2 node3
        ;;
    
    restart-node)
        if [ -z "$ARGUMENT" ]; then
            echo "No node specified. Usage: ./tempodb restart-node <node>"
            exit 1
        fi
        echo "Restarting node: $ARGUMENT"
        docker-compose restart $ARGUMENT
        ;;
    
    get-leader)
        echo "Querying current leader..."
        curl -s http://localhost:2275/raft/leader | jq .
        ;;
    
    *)
        echo "Unknown command: $COMMAND"
        echo "Usage: ./tempodb [start|stop|rebuild|status|logs|restart-node <node>|get-leader]"
        exit 1
        ;;
esac
