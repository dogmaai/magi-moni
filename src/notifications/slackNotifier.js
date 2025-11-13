const axios = require('axios');

class SlackNotifier {
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }

    async sendNotification(message) {
        const payload = {
            text: message,
        };

        try {
            await axios.post(this.webhookUrl, payload);
            console.log('Notification sent to Slack!');
        } catch (error) {
            console.error('Error sending notification to Slack:', error);
        }
    }
}

module.exports = SlackNotifier;