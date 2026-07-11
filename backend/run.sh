#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Compiling..."
javac ConsistentHashRing.java ConsistentHashDemo.java
echo "Starting server on http://localhost:8080"
echo "Open frontend/index.html in your browser."
java ConsistentHashDemo
