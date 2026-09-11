#!/bin/bash
# public/system/hostfs.sys が tools/x68/hostfs.s から再現できることを確かめる検査。
#
# 公開用(GitHub Pages)のビルドではvasmを動かせないため、同梱の
# public/system/hostfs.sys はビルド済みバイナリを直接置いている(HOSTFS.SYSは
# 自作物であり、Sharpの許諾条件とは無関係)。
# このスクリプトは tools/x68/build-hostfs.sh で改めてアセンブルし直し、
# sha256が公開物と一致することを確認する(=同梱物はソースから再現可能で、
# 由来不明のバイナリではないことの検査)。
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISHED="$REPO_DIR/public/system/hostfs.sys"

if [ ! -f "$PUBLISHED" ]; then
  echo "エラー: $PUBLISHED が見つかりません。" >&2
  exit 1
fi

echo "== ソースから再アセンブル =="
bash "$REPO_DIR/tools/x68/build-hostfs.sh"

REBUILT="$REPO_DIR/_local/hostfs/HOSTFS.SYS"
HASH_PUBLISHED=$(shasum -a 256 "$PUBLISHED" | awk '{print $1}')
HASH_REBUILT=$(shasum -a 256 "$REBUILT" | awk '{print $1}')

echo "公開物   : $HASH_PUBLISHED  ($PUBLISHED)"
echo "再アセンブル: $HASH_REBUILT  ($REBUILT)"

if [ "$HASH_PUBLISHED" = "$HASH_REBUILT" ]; then
  echo "OK: バイト一致。public/system/hostfs.sys は tools/x68/hostfs.s から再現できます。"
  exit 0
else
  echo "NG: 一致しません。public/system/hostfs.sys を再ビルドして更新してください。" >&2
  exit 1
fi
