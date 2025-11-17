#!/bin/bash

echo "🚀 Magi-Moni をデプロイ中..."

# Terraform デプロイ
cd terraform

echo "📋 Terraform を初期化中..."
terraform init

echo "📊 Terraform Plan を実行中..."
terraform plan -out=tfplan

echo "✅ 確認してください。デプロイするには: terraform apply tfplan"

