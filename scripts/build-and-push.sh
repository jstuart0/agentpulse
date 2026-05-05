#!/usr/bin/env bash
# build-and-push.sh — Build and push a SHA-tagged agentpulse image.
#
# Usage:
#   ./scripts/build-and-push.sh
#   REGISTRY=192.168.10.222:30500 ./scripts/build-and-push.sh
#
# After pushing, update the image: field in deploy/k8s/04-deployment.yaml
# (or the homelab deployment-patch.yaml) to the printed tag, then apply.
# See deploy/k8s/README.md for the full operator workflow.
#
# Environment variables:
#   REGISTRY   — container registry prefix (default: ghcr.io/jstuart0)
#   PLATFORM   — target platform (default: linux/amd64)

set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io/jstuart0}"
PLATFORM="${PLATFORM:-linux/amd64}"
SHA=$(git rev-parse --short HEAD)
IMAGE="$REGISTRY/agentpulse:$SHA"

echo "Building $IMAGE for $PLATFORM..."
docker build --platform "$PLATFORM" -t "$IMAGE" .

echo "Pushing $IMAGE..."
docker push "$IMAGE"

echo ""
echo "Pushed: $IMAGE"
echo ""
echo "Next step: update the image: field in deploy/k8s/04-deployment.yaml"
echo "  image: $IMAGE"
echo ""
echo "Then apply:"
echo "  kubectl apply -f deploy/k8s/          # base"
echo "  kubectl apply -k deploy/k8s-homelab/  # homelab overlay"
