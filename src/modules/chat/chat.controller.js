const chatService = require('./chat.service');
const { apiResponse } = require('../../common/utils/apiResponse');

const getChat = async (req, res, next) => {
  try {
    const { id } = req.params;
    const chat = await chatService.getChatByJobCard(id);

    return apiResponse(res, {
      statusCode: 200,
      success: true,
      message: 'Chat history retrieved successfully',
      data: chat
    });
  } catch (error) {
    return next(error);
  }
};

const sendReply = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { text, audioData, mediaUrl, fileData, fileName, fileType } = req.body;
    const userId = req.user?.id;
    const userName = req.user?.fullName || req.user?.name || 'Service Advisor';

    const result = await chatService.sendAdvisorReply({
      jobCardId: id,
      text,
      audioData,
      mediaUrl,
      fileData,
      fileName,
      fileType,
      userId,
      userName
    });

    return apiResponse(res, {
      statusCode: 201,
      success: true,
      message: 'Message sent to customer successfully',
      data: result
    });
  } catch (error) {
    return next(error);
  }
};

const markRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await chatService.markChatAsRead(id);

    return apiResponse(res, {
      statusCode: 200,
      success: true,
      message: 'Chat marked as read',
      data: result
    });
  } catch (error) {
    return next(error);
  }
};

const getRecentChats = async (req, res, next) => {
  try {
    const roleSlug = String(req.user?.roleSlug || '').toLowerCase().replace(/[-_\s]+/g, '');
    if (roleSlug === 'admin' || roleSlug === 'superadmin') {
      return apiResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Admin role does not track direct chats',
        data: {
          totalUnreadCount: 0,
          chats: []
        }
      });
    }

    const { locationId, search, unreadOnly, limit } = req.query;
    const effectiveLocationId = req.user?.locationId || locationId;

    const data = await chatService.listRecentChats({
      locationId: effectiveLocationId,
      search,
      unreadOnly: unreadOnly === 'true',
      limit
    });

    return apiResponse(res, {
      statusCode: 200,
      success: true,
      message: 'Recent chats retrieved successfully',
      data
    });
  } catch (error) {
    return next(error);
  }
};

const twilioStatusWebhook = async (req, res, next) => {
  try {
    const messageSid = req.body?.MessageSid || req.body?.SmsSid;
    const messageStatus = req.body?.MessageStatus || req.body?.SmsStatus;
    if (messageSid && messageStatus) {
      await chatService.updateMessageStatusByTwilioSid(messageSid, messageStatus);
    }
    return res.status(200).send('OK');
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getChat,
  sendReply,
  markRead,
  getRecentChats,
  twilioStatusWebhook
};
