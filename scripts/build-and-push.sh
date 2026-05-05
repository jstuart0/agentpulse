#!/usr/bin/env bash
# build-and-push.sh — Build and push a SHA-tagged agentpulse image.
#
# Usage:
#   ./scripts/build-and-push.sh
#   REGISTRY=registry.example.com:5000 ./scripts/build-and-push.sh
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
BACKUP_IMAGE="$REGISTRY/agentpulse-backup:$SHA"

echo "Building $IMAGE for $PLATFORM..."
docker build --platform "$PLATFORM" -t "$IMAGE" .

echo "Pushing $IMAGE..."
docker push "$IMAGE"

# Build and push the backup sidecar image. Uses a separate Dockerfile that
# bakes in sqlite, rsync, and the backup/retention scripts. Tagged with the
# same SHA as the app image so both are always deployed in lockstep.
echo ""
echo "Building $BACKUP_IMAGE for $PLATFORM..."
docker build --platform "$PLATFORM" -f deploy/k8s/Dockerfile.backup -t "$BACKUP_IMAGE" .

echo "Pushing $BACKUP_IMAGE..."
docker push "$BACKUP_IMAGE"

echo ""
echo "Pushed: $IMAGE"
echo "Pushed: $BACKUP_IMAGE"
echo ""
echo "Next step: update the image: fields in deploy/k8s/04-deployment.yaml"
echo "  agentpulse container:        image: $IMAGE"
echo "  backup-sidecar container:    image: $BACKUP_IMAGE"
echo ""
echo "Then apply:"
echo "  kubectl apply -k deploy/k8s/          # base"
echo "  kubectl apply -k deploy/k8s-homelab/  # homelab overlay"
