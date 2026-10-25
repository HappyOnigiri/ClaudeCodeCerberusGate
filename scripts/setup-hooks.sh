#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
hooks_dir=$(git rev-parse --path-format=absolute --git-common-dir)/hooks

# グローバルの dispatcher は維持し、リポジトリ固有の上書き設定だけ拒否する。
hooks_setting=$(git config --show-scope --get core.hooksPath || true)
case "$hooks_setting" in
  local* | worktree*)
    echo 'Error: リポジトリ固有の core.hooksPath を解除してから再実行してください。' >&2
    exit 1
    ;;
esac

source_hook="$root/scripts/hooks/pre-commit"
destination="$hooks_dir/pre-commit"
mkdir -p "$hooks_dir"

# 既存の別の hook を無断で置き換えない。同じ内容なら再導入できる。
if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ -L "$destination" ] || ! cmp -s "$source_hook" "$destination"; then
    echo "Error: 既存の hook を保持しました: $destination" >&2
    exit 1
  fi
fi

cp "$source_hook" "$destination"
chmod 755 "$destination"
echo "Installed: $destination"
