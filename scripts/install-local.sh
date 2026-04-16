#!/usr/bin/env bash
set -euo pipefail

# AgentPulse local installer
# One-command Bun + SQLite deployment for macOS/Linux.

REPO_URL="https://github.com/jaystuart/agentpulse.git"
REPO_REF="main"
INSTALL_DIR="${HOME}/.agentpulse/app"
DATA_DIR="${HOME}/.agentpulse/data"
PORT="3000"
HOST="0.0.0.0"
PUBLIC_URL=""
DISABLE_AUTH="true"
SERVICE_MODE="auto"
SERVICE_NAME="agentpulse"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REPO_REF="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --disable-auth) DISABLE_AUTH="$2"; shift 2 ;;
    --service) SERVICE_MODE="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
AgentPulse local installer

Usage:
  curl -fsSL <script-url> | bash

Options:
  --ref <git-ref>          Git branch/tag to install (default: main)
  --repo <git-url>         Git repo to install from
  --dir <path>             Install directory (default: ~/.agentpulse/app)
  --data-dir <path>        SQLite/data directory (default: ~/.agentpulse/data)
  --port <port>            Web port (default: 3000)
  --host <host>            Bind host (default: 0.0.0.0)
  --public-url <url>       Public URL used for setup.sh output
  --disable-auth <bool>    Set DISABLE_AUTH (default: true)
  --service <mode>         auto | none | systemd | launchd
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "${PUBLIC_URL}" ]]; then
  PUBLIC_URL="http://localhost:${PORT}"
fi

echo ""
echo "  AgentPulse Local Install"
echo "  ────────────────────────"
echo "  Repo:       ${REPO_URL} (${REPO_REF})"
echo "  Install:    ${INSTALL_DIR}"
echo "  Data:       ${DATA_DIR}"
echo "  URL:        ${PUBLIC_URL}"
echo "  Service:    ${SERVICE_MODE}"
echo ""

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_bun() {
  if need_cmd bun; then
    echo "  ✓ Bun: $(command -v bun)"
    return
  fi
  if [[ -x "${HOME}/.bun/bin/bun" ]]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
    echo "  ✓ Bun: ${HOME}/.bun/bin/bun"
    return
  fi
  echo "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export PATH="${HOME}/.bun/bin:${PATH}"
  echo "  ✓ Bun: ${HOME}/.bun/bin/bun"
}

if ! need_cmd git; then
  echo "Error: git is required for local installation."
  exit 1
fi

install_bun

mkdir -p "$(dirname "${INSTALL_DIR}")" "${DATA_DIR}"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "  Updating existing checkout..."
  git -C "${INSTALL_DIR}" fetch --tags origin
  git -C "${INSTALL_DIR}" checkout "${REPO_REF}"
  git -C "${INSTALL_DIR}" pull --ff-only origin "${REPO_REF}" || true
else
  echo "  Cloning repository..."
  rm -rf "${INSTALL_DIR}"
  git clone --branch "${REPO_REF}" --single-branch "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

echo "  Installing dependencies..."
bun install

echo "  Building application..."
bun run build

ENV_FILE="${INSTALL_DIR}/.env.local"
cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=${HOST}
PUBLIC_URL=${PUBLIC_URL}
DISABLE_AUTH=${DISABLE_AUTH}
DATA_DIR=${DATA_DIR}
SQLITE_PATH=${DATA_DIR}/agentpulse.db
NODE_ENV=production
EOF
echo "  ✓ Wrote ${ENV_FILE}"

create_systemd() {
  mkdir -p "${HOME}/.config/systemd/user"
  local unit="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
  cat > "${unit}" <<EOF
[Unit]
Description=AgentPulse local server
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${HOME}/.bun/bin/bun run start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}" >/dev/null
  echo "  ✓ systemd user service started"
  echo "    Logs: journalctl --user -u ${SERVICE_NAME} -f"
}

create_launchd() {
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/.agentpulse/logs"
  local plist="${HOME}/Library/LaunchAgents/dev.agentpulse.local.plist"
  cat > "${plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.local</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HOME}/.bun/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${PORT}</string>
    <key>HOST</key><string>${HOST}</string>
    <key>PUBLIC_URL</key><string>${PUBLIC_URL}</string>
    <key>DISABLE_AUTH</key><string>${DISABLE_AUTH}</string>
    <key>DATA_DIR</key><string>${DATA_DIR}</string>
    <key>SQLITE_PATH</key><string>${DATA_DIR}/agentpulse.db</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.agentpulse/logs/agentpulse.out.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.agentpulse/logs/agentpulse.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "${plist}" >/dev/null 2>&1 || true
  launchctl load "${plist}"
  echo "  ✓ launchd service started"
  echo "    Logs: tail -f ${HOME}/.agentpulse/logs/agentpulse.out.log"
}

if [[ "${SERVICE_MODE}" == "auto" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    SERVICE_MODE="launchd"
  elif need_cmd systemctl; then
    SERVICE_MODE="systemd"
  else
    SERVICE_MODE="none"
  fi
fi

case "${SERVICE_MODE}" in
  systemd)
    create_systemd
    ;;
  launchd)
    create_launchd
    ;;
  none)
    echo "  Starting AgentPulse in the background..."
    env $(tr '\n' ' ' < "${ENV_FILE}") "${HOME}/.bun/bin/bun" run start > "${HOME}/.agentpulse/agentpulse.log" 2>&1 &
    echo $! > "${HOME}/.agentpulse/agentpulse.pid"
    echo "  ✓ Started background process"
    echo "    Logs: tail -f ${HOME}/.agentpulse/agentpulse.log"
    ;;
  *)
    echo "Error: unsupported --service mode '${SERVICE_MODE}'"
    exit 1
    ;;
esac

echo ""
echo "  Waiting for AgentPulse to start..."
for _ in $(seq 1 30); do
  if curl -fsSL "${PUBLIC_URL}/api/v1/health" >/dev/null 2>&1; then
    echo "  ✓ AgentPulse is running at ${PUBLIC_URL}"
    echo ""
    echo "  Next step:"
    echo "    curl -sSL ${PUBLIC_URL}/setup.sh | bash"
    echo ""
    echo "  Open:"
    echo "    ${PUBLIC_URL}"
    exit 0
  fi
  sleep 1
done

echo ""
echo "  AgentPulse was installed but the health check did not pass in time."
echo "  Try starting it manually:"
echo "    cd ${INSTALL_DIR}"
echo "    export \$(cat .env.local | xargs)"
echo "    ${HOME}/.bun/bin/bun run start"
exit 1
