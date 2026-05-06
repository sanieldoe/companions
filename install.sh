#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Install failed at line $LINENO" >&2; exit 1' ERR

VERSION="0.1.0"
REPO_URL="${COMPANIONS_REPO_URL:-https://github.com/sanieldoe/companions.git}"
INSTALL_DIR="${COMPANIONS_INSTALL_DIR:-$HOME/companions}"
BRANCH="${COMPANIONS_BRANCH:-main}"
SKIP_SETUP="${COMPANIONS_SKIP_SETUP:-0}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ;;
  esac
done

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ $*"
  else
    "$@"
  fi
}

run_in() {
  local dir="$1"
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ (cd $dir && $*)"
  else
    (cd "$dir" && "$@")
  fi
}

phase() {
  echo
  echo "==> $1"
}

banner() {
  cat <<EOF
   ______                                 _
  / ____/___  ____ ___  ____  ____ _____  (_)___  ____  _____
 / /   / __ \/ __ \\__ \/ __ \/ __ '/ __ \/ / __ \/ __ \/ ___/
/ /___/ /_/ / / / /__/ / /_/ / /_/ / / / / / /_/ / / / (__  )
\____/\____/_/ /_/____/ .___/\__,_/_/ /_/_/\____/_/ /_/____/
                     /_/

Companions installer v${VERSION}
EOF
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

print_node_help() {
  local os_name="$1"
  echo "Node.js 20+ is required."
  if [[ "$os_name" == "Darwin" ]]; then
    echo "Install with: brew install node"
  else
    echo "Install with NodeSource or your package manager."
    echo "Example: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "         sudo apt-get install -y nodejs"
  fi
  echo "Or use: nvm install 20 && nvm use 20"
}

banner

phase "Detect OS"
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin|Linux) echo "Detected: $OS_NAME" ;;
  *)
    echo "Unsupported OS: $OS_NAME"
    echo "Windows users: please use WSL."
    exit 1
    ;;
esac

phase "Check prerequisites"
if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not installed."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not installed."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  print_node_help "$OS_NAME"
  exit 1
fi
if [[ "$(node_major)" -lt 20 ]]; then
  print_node_help "$OS_NAME"
  exit 1
fi

git --version
node --version
npm --version

phase "Prepare install directory"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Existing git repo found at $INSTALL_DIR"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ (cd $INSTALL_DIR && git pull --ff-only origin $BRANCH)"
  else
    (cd "$INSTALL_DIR" && git pull --ff-only origin "$BRANCH")
  fi
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "Install directory exists and is not a git repo: $INSTALL_DIR"
  exit 1
else
  run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

phase "Install dependencies"
run_in "$INSTALL_DIR/server" npm install
run_in "$INSTALL_DIR/app" npm install
run_in "$INSTALL_DIR/web" npm install

phase "Run setup"
if [[ "$SKIP_SETUP" == "1" ]]; then
  echo "Skipping setup because COMPANIONS_SKIP_SETUP=1"
else
  run_in "$INSTALL_DIR/server" npm run setup
fi

phase "Done"
echo "To start: cd $INSTALL_DIR/server && npm start"
