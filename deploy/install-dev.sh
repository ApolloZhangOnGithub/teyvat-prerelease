#!/bin/bash
set -e
R='\033[0m'; RED='\033[31m'; GRN='\033[32m'

err() { echo -e "  ${RED}ERROR${R}  $1"; exit 1; }

command -v git  >/dev/null || err "need git: xcode-select --install"
command -v node >/dev/null || err "need node: brew install node"

DIR="$HOME/Agent Intelligence/MODERN/TEYVAT/teyvat-main"
REPO="git@github.com:ApolloZhangOnGithub/teyvat-dev.git"

mkdir -p "$DIR"

if [ -d "$DIR/A.core/.git" ]; then
  echo "  pulling latest..."
  git -C "$DIR/A.core" pull --ff-only 2>/dev/null || true
else
  echo "  cloning..."
  git clone "$REPO" "$DIR/A.core"
fi

cd "$DIR/A.core"
[ -d node_modules ] || npm install

export PAIMON_VIA_MAKE=1
PAIMON_CHANNEL="minutely" bash ../C.deploy/install.sh
