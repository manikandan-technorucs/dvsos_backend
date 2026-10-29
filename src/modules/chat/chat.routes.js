const router = require('express').Router();
const controller = require('./chat.controller');
const { authenticate } = require('../../common/middleware/auth.middleware');

// Public status callback webhook from Twilio
router.post('/twilio/status', controller.twilioStatusWebhook);

router.use(authenticate);

router.get('/recent-chats', controller.getRecentChats);
router.get('/job-card/:id', controller.getChat);
router.post('/job-card/:id/messages', controller.sendReply);
router.post('/job-card/:id/read', controller.markRead);

module.exports = router;
