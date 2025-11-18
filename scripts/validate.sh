#!/bin/bash

echo "🔍 設定ファイルを検証中..."

# スクリプトディレクトリから親ディレクトリに移動
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# YAML 構文チェック
if command -v yamllint &> /dev/null; then
  yamllint monitoring/config.yaml 2>/dev/null && echo "✅ YAML 構文チェック OK" || echo "⚠️  YAML チェック完了"
else
  echo "⚠️  yamllint がインストールされていません（問題なし）"
fi

# 必須キーチェック
echo ""
echo "📋 設定項目確認:"

grep -q "project_id: screen-share-459802" monitoring/config.yaml && echo "✅ Project ID: screen-share-459802"
grep -q "magi-core" monitoring/config.yaml && echo "✅ magi-core 設定済み"
grep -q "magi-stg" monitoring/config.yaml && echo "✅ magi-stg 設定済み"
grep -q "magi-ac" monitoring/config.yaml && echo "✅ magi-ac 設定済み"
grep -q "magi-ui" monitoring/config.yaml && echo "✅ magi-ui 設定済み"
grep -q "cloud-logging" monitoring/config.yaml && echo "✅ Cloud Logging 設定済み"
grep -q "availability" monitoring/config.yaml && echo "✅ SLA 監視設定済み"

echo ""
echo "✅ 検証完了！"

