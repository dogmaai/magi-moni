const express = require('express');
const app = express();
const PORT = process.env.PORT || 8888;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'magi-moni',
    version: '1.0.0'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('MAGI Monitoring on port ' + PORT);
});
