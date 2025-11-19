# magi-moni

Monitoring Status Dashboard - システム監視・モニタリングダッシュボード

## 機能

このダッシュボードは以下の監視・モニタリング機能を提供します：

### 1. サービス死活監視 🏥
- GCP上にデプロイされたAPIエンドポイントのHTTP/HTTPSヘルスチェック
- バックグラウンドでの定期監視（デフォルト: 60秒間隔）
- サービスごとの稼働状態表示（稼働中/停止中）
- レスポンスタイム測定
- 監視対象サービスは `monitoring/config.yaml` で設定可能

### 2. リソース使用状況グラフ 💻💾
- CPU使用率のリアルタイム監視とグラフ表示
- メモリ使用率のリアルタイム監視とグラフ表示
- 履歴データの可視化（最新20データポイント）
- モックデータまたは実際のシステムメトリクスから選択可能

### 3. アラート通知 ⚠️
- エラー発生時の画面上通知
- 重要度別表示（warning/critical）
- サービス停止時の自動アラート生成
- アラートのリアルタイム更新

### 4. APIリクエスト統計 📊
- 指定期間でのAPIリクエスト数サマリー
- エンドポイント別の統計（総数、成功数、失敗数）
- ユーザー別の統計
- 日付範囲でのフィルタリング機能
- 成功率の自動計算

## セットアップ

### 必要要件
- Node.js v16以上
- npm

### インストール

```bash
# 依存関係のインストール
npm install

# サーバー起動
npm start
```

サーバーは `http://localhost:3000` で起動します。

### 設定

#### 監視対象サービスの設定

`monitoring/config.yaml` を編集してサービスを追加：

```yaml
monitoring:
  interval: 60  # チェック間隔（秒）
  services:
    - name: My API
      url: https://api.example.com/health
      critical: true
    - name: Another Service
      url: https://service.example.com
      critical: false
```

#### リソースモニタリングの設定

`src/monitoring/resourceMonitor.js` のコンストラクタで切り替え：
- `useMockData: true` - モックデータを使用（デフォルト）
- `useMockData: false` - 実際のシステムメトリクスを使用

## API エンドポイント

### GET /api/health/status
すべてのサービスの死活状態を取得

### GET /api/resources/metrics
CPU・メモリなどのリソース使用状況を取得

### GET /api/requests/summary
APIリクエストの統計サマリーを取得
- クエリパラメータ: `startDate`, `endDate`, `user`

### GET /api/alerts
現在のアラート一覧を取得

### POST /api/requests/log
APIリクエストをログに記録
- Body: `{ endpoint, user, status }`

## データストレージ

APIリクエストログは `data/request-logs.json` にJSON形式で保存されます。

## 自動更新

ダッシュボードは30秒ごとに自動更新されます。

## 今後の拡張予定

- メール通知機能の追加（SMTP設定）
- GCP Monitoring APIとの本格的な連携
- より詳細なメトリクス表示
- ログのデータベース保存（MongoDB連携）

## ライセンス

ISC

