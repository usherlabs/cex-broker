#!/bin/sh

# Get the main repo path from the .git file when in a git worktree.
if [ -e .git ] && [ -f .git ]; then
  MAIN_REPO=$(sed -E 's|^gitdir:\s*(.*/\.git)/.*|\1|' .git)
  echo "MAIN_REPO=$MAIN_REPO" > .devcontainer/.env
else
  rm -f .devcontainer/.env
fi

