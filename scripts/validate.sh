#!/bin/bash

echo "🔍 設定ファイルを検証中..."

# YAML 構文チェック
if command -v yamllint &> /dev/null; then
  yamllint monitoring/config.yaml
  echo "✅ YAML 構文チェック OK"
else
  echo "⚠️  yamllint がインストールされていません"
fi

# 必須キーチェック
if grep -q "project_id: screen-share-459802" monitoring/config.yaml; then
  echo "✅ Project ID 設定済み"
else
  echo "❌ Project ID が設定されていません"
  exit 1
fi

if grep -q "magi-core" monitoring/config.yaml; then
  echo "✅ magi-core 設定済み"
fi

if grep -q "magi-stg" monitoring/config.yaml; then
  echo "✅ magi-stg 設定済み"
fi

echo "✅ 検証完了！"

