#!/usr/bin/env sh
set -eu

INSTALL_URL="http://local-ca/install.sh"

# Run the local CA installer, then exec the provided command.
curl -fsSL --retry 60 --retry-all-errors --retry-delay 1 "$INSTALL_URL" | sudo sh

exec "$@"
