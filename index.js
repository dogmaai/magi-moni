const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// 取引結果の履歴を保存
const tradeResults = [];

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'magi-moni',
    version: '1.1.0',
    resultsCount: tradeResults.length
  });
});

// Pub/Sub エンドポイント - trade-results受信
app.post('/pubsub/trade-result', (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.data) {
      console.log('[MONI] No message data');
      return res.status(200).send('OK');
    }

    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    console.log('[MONI] Received trade result:', JSON.stringify(data));
    
    // 履歴に保存
    tradeResults.push({
      ...data,
      receivedAt: new Date().toISOString()
    });

    // 最新100件のみ保持
    if (tradeResults.length > 100) {
      tradeResults.shift();
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[MONI] Error processing message:', error.message);
    res.status(200).send('OK'); // エラーでも200を返してリトライを防ぐ
  }
});

// 取引結果履歴取得
app.get('/results', (req, res) => {
  res.json({
    count: tradeResults.length,
    results: tradeResults.slice(-20).reverse()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('MAGI Monitoring on port ' + PORT);
});
