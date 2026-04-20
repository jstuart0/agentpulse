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
API_KEY=""
AUTO_HOOKS="true"
AUTO_SUPERVISOR="true"
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
    --api-key) API_KEY="$2"; shift 2 ;;
    --skip-hooks) AUTO_HOOKS="false"; shift 1 ;;
    --skip-supervisor) AUTO_SUPERVISOR="false"; shift 1 ;;
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
  --api-key <key>          Set AGENTPULSE_INITIAL_API_KEY
  --skip-hooks             Do not auto-run setup.sh after install
  --skip-supervisor        Do not auto-install the local supervisor
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
echo "  Hooks:      ${AUTO_HOOKS}"
echo "  Supervisor: ${AUTO_SUPERVISOR}"
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
AGENTPULSE_INITIAL_API_KEY=${API_KEY}
DATA_DIR=${DATA_DIR}
SQLITE_PATH=${DATA_DIR}/agentpulse.db
NODE_ENV=production
EOF
echo "  ✓ Wrote ${ENV_FILE}"

AGENTPULSE_DIR="${HOME}/.agentpulse"
LOG_DIR="${AGENTPULSE_DIR}/logs"
SUPERVISOR_CONFIG_FILE="${AGENTPULSE_DIR}/supervisor.json"
SUPERVISOR_ENROLLMENT_TOKEN=""
mkdir -p "${AGENTPULSE_DIR}" "${LOG_DIR}"

json_escape() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

configure_supervisor() {
  local trusted_root="${HOME}/dev"
  if [[ ! -d "${trusted_root}" ]]; then
    trusted_root="${HOME}"
  fi

  local enrollment_json="null"
  local api_key_json="null"
  local claude_json="null"
  local codex_json="null"

  if [[ -n "${SUPERVISOR_ENROLLMENT_TOKEN}" ]]; then
    enrollment_json="$(json_escape "${SUPERVISOR_ENROLLMENT_TOKEN}")"
  fi
  if [[ -n "${API_KEY}" ]]; then
    api_key_json="$(json_escape "${API_KEY}")"
  fi
  if command -v claude >/dev/null 2>&1; then
    claude_json="$(json_escape "$(command -v claude)")"
  fi
  if command -v codex >/dev/null 2>&1; then
    codex_json="$(json_escape "$(command -v codex)")"
  fi

  python3 - "${SUPERVISOR_CONFIG_FILE}" "${PUBLIC_URL}" "${trusted_root}" "${enrollment_json}" "${api_key_json}" "${claude_json}" "${codex_json}" <<'PY'
import json, os, socket, sys
path, server_url, trusted_root, enrollment_json, api_key_json, claude_json, codex_json = sys.argv[1:]
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
data["serverUrl"] = server_url
data["hostName"] = data.get("hostName") or socket.gethostname()
data["trustedRoots"] = data.get("trustedRoots") or [trusted_root]
enrollment = json.loads(enrollment_json)
if enrollment:
    data["enrollmentToken"] = enrollment
api_key = json.loads(api_key_json)
if api_key:
    data["apiKey"] = api_key
claude = json.loads(claude_json)
if claude:
    data["claudeCommand"] = claude
codex = json.loads(codex_json)
if codex:
    data["codexCommand"] = codex
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  echo "  ✓ Wrote ${SUPERVISOR_CONFIG_FILE}"
}

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

create_supervisor_systemd() {
  mkdir -p "${HOME}/.config/systemd/user"
  local unit="${HOME}/.config/systemd/user/${SERVICE_NAME}-supervisor.service"
  cat > "${unit}" <<EOF
[Unit]
Description=AgentPulse local supervisor
After=network.target ${SERVICE_NAME}.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
Environment=HOME=${HOME}
Environment=PATH=${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=${HOME}/.bun/bin/bun run supervisor
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}-supervisor" >/dev/null
  echo "  ✓ systemd supervisor started"
  echo "    Logs: journalctl --user -u ${SERVICE_NAME}-supervisor -f"
}

create_launchd() {
  mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
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
    <key>AGENTPULSE_INITIAL_API_KEY</key><string>${API_KEY}</string>
    <key>DATA_DIR</key><string>${DATA_DIR}</string>
    <key>SQLITE_PATH</key><string>${DATA_DIR}/agentpulse.db</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/agentpulse.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/agentpulse.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "${plist}" >/dev/null 2>&1 || true
  launchctl load "${plist}"
  echo "  ✓ launchd service started"
  echo "    Logs: tail -f ${LOG_DIR}/agentpulse.out.log"
}

create_supervisor_launchd() {
  mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
  local plist="${HOME}/Library/LaunchAgents/dev.agentpulse.supervisor.plist"
  cat > "${plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HOME}/.bun/bin/bun</string>
    <string>run</string>
    <string>supervisor</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>${PORT}</string>
    <key>HOST</key><string>${HOST}</string>
    <key>PUBLIC_URL</key><string>${PUBLIC_URL}</string>
    <key>DISABLE_AUTH</key><string>${DISABLE_AUTH}</string>
    <key>AGENTPULSE_INITIAL_API_KEY</key><string>${API_KEY}</string>
    <key>DATA_DIR</key><string>${DATA_DIR}</string>
    <key>SQLITE_PATH</key><string>${DATA_DIR}/agentpulse.db</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/supervisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/supervisor.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "${plist}" >/dev/null 2>&1 || true
  launchctl load "${plist}"
  echo "  ✓ launchd supervisor started"
  echo "    Logs: tail -f ${LOG_DIR}/supervisor.out.log"
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
    env $(tr '\n' ' ' < "${ENV_FILE}") "${HOME}/.bun/bin/bun" run start > "${LOG_DIR}/agentpulse.out.log" 2>&1 &
    echo $! > "${AGENTPULSE_DIR}/agentpulse.pid"
    echo "  ✓ Started background process"
    echo "    Logs: tail -f ${LOG_DIR}/agentpulse.out.log"
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
    if [[ "${AUTO_SUPERVISOR}" == "true" ]]; then
      if [[ "${DISABLE_AUTH}" != "true" ]]; then
        if [[ -n "${API_KEY}" ]]; then
          echo "  Creating local supervisor enrollment token..."
          SUPERVISOR_ENROLLMENT_TOKEN="$(
            curl -fsSL -X POST \
              -H "Authorization: Bearer ${API_KEY}" \
              -H "Content-Type: application/json" \
              "${PUBLIC_URL}/api/v1/supervisors/enroll" \
              -d '{"name":"local-supervisor"}' \
            | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
          )"
          echo "  ✓ Enrollment token issued"
        else
          echo "  ! Skipping supervisor auto-install because auth is enabled and no --api-key was provided."
          echo "    Add a supervisor later from Hosts, or rerun with --api-key."
          echo ""
        fi
      fi
      if [[ "${DISABLE_AUTH}" == "true" || -n "${SUPERVISOR_ENROLLMENT_TOKEN}" ]]; then
        echo "  Configuring local supervisor..."
        configure_supervisor
        case "${SERVICE_MODE}" in
          systemd)
            create_supervisor_systemd
            ;;
          launchd)
            create_supervisor_launchd
            ;;
          none)
            echo "  Starting AgentPulse supervisor in the background..."
            HOME="${HOME}" PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
              env $(tr '\n' ' ' < "${ENV_FILE}") "${HOME}/.bun/bin/bun" run supervisor > "${LOG_DIR}/supervisor.out.log" 2> "${LOG_DIR}/supervisor.err.log" &
            echo $! > "${AGENTPULSE_DIR}/supervisor.pid"
            echo "  ✓ Started background supervisor"
            echo "    Logs: tail -f ${LOG_DIR}/supervisor.out.log"
            ;;
        esac
        echo ""
      fi
    fi
    if [[ "${AUTO_HOOKS}" == "true" ]]; then
      if [[ "${DISABLE_AUTH}" == "true" ]]; then
        echo "  Configuring Claude Code + Codex hooks..."
        curl -fsSL "${PUBLIC_URL}/setup.sh" | bash
        echo ""
        echo "  ✓ Hooks configured"
      elif [[ -n "${API_KEY}" ]]; then
        echo "  Configuring Claude Code + Codex hooks with API key..."
        curl -fsSL "${PUBLIC_URL}/setup.sh" | bash -s -- --key "${API_KEY}"
        echo ""
        echo "  ✓ Hooks configured"
      else
        echo "  ! Skipping automatic hook setup because auth is enabled and no --api-key was provided."
        echo "    Run this next:"
        echo "      curl -sSL ${PUBLIC_URL}/setup.sh | bash -s -- --key ap_YOUR_KEY"
        echo ""
      fi
    else
      echo "  Next step:"
      echo "    curl -sSL ${PUBLIC_URL}/setup.sh | bash"
      echo ""
    fi
    echo "  Local control plane:"
    if [[ "${AUTO_SUPERVISOR}" == "true" ]]; then
      echo "    enabled"
    else
      echo "    skipped (--skip-supervisor)"
    fi
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
