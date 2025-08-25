#!/bin/bash
# deploy.sh — Quick deploy for functions + hosting with auto-inject

set -e  # Stop on first error

echo "=== Injecting welcome scripts into HTML pages ==="
./inject-welcome.sh

echo "=== Deploying functions + hosting to Firebase ==="
npx firebase-tools@latest deploy --only functions,hosting

echo "=== Deploy complete! ==="