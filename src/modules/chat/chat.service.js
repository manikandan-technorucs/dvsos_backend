const prisma = require('../../config/db');
const { getSocket } = require('../../config/socket');
const { sendWhatsAppMessage } = require('../../providers/whatsapp/whatsapp.service');
const { createStorageProvider } = require('../../providers/storage/storage.provider');
const env = require('../../config/env');

let storageProviderInstance = null;
const getStorageProvider = () => {
  if (!storageProviderInstance) {
    try {
      storageProviderInstance = createStorageProvider();
    } catch (e) {
      console.warn('[Chat] Could not initialize storage provider:', e.message);
    }
  }
  return storageProviderInstance;
};

const extractBlobNameFromUrl = (url, containerName) => {
  if (!url || typeof url !== 'string') return null;
  const container = containerName || env.azureBlob?.container || 'susee-objects';

  if (url.includes('.blob.core.windows.net/')) {
    const afterHost = url.split('.blob.core.windows.net/')[1];
    if (afterHost) {
      const firstSlash = afterHost.indexOf('/');
      if (firstSlash !== -1) {
        const blobPart = afterHost.substring(firstSlash + 1).split('?')[0];
        try {
          return decodeURIComponent(blobPart);
        } catch {
          return blobPart;
        }
      }
    }
  }

  const marker = `/${container}/`;
  if (url.includes(marker)) {
    const afterMarker = url.split(marker)[1];
    if (afterMarker) {
      const blobPart = afterMarker.split('?')[0];
      try {
        return decodeURIComponent(blobPart);
      } catch {
        return blobPart;
      }
    }
  }

  return null;
};

const signChatMessageMediaUrl = (mediaUrl, blobName, expirySeconds = 86400) => {
  if (!mediaUrl && !blobName) return mediaUrl;

  const provider = getStorageProvider();
  if (!provider || !provider.isConfigured || typeof provider.generateSasUrl !== 'function') {
    return mediaUrl;
  }

  const resolvedBlobName = blobName || extractBlobNameFromUrl(mediaUrl, provider.config?.container);
  if (!resolvedBlobName) {
    return mediaUrl;
  }

  try {
    return provider.generateSasUrl(resolvedBlobName, expirySeconds);
  } catch (err) {
    console.warn('[Chat] Failed to sign SAS URL for media file:', err.message);
    return mediaUrl;
  }
};

const CHAT_SCHEMA_SQL = `
IF OBJECT_ID('dbo.job_card_chats', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.job_card_chats (
    id INT IDENTITY(1,1) PRIMARY KEY,
    job_card_id INT NOT NULL UNIQUE,
    customer_id INT NOT NULL,
    customer_mobile NVARCHAR(20) NOT NULL,
    unread_count INT NOT NULL DEFAULT 0,
    last_message_text NVARCHAR(500) NULL,
    last_sender_type NVARCHAR(20) NULL,
    last_message_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    messages_json NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_job_card_chats_job_card_id ON dbo.job_card_chats(job_card_id);
  CREATE INDEX IX_job_card_chats_customer_mobile ON dbo.job_card_chats(customer_mobile);
  CREATE INDEX IX_job_card_chats_unread_count ON dbo.job_card_chats(unread_count);
  CREATE INDEX IX_job_card_chats_last_message_at ON dbo.job_card_chats(last_message_at);
END
`;

let schemaPromise = null;
const ensureChatSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      try {
        await prisma.$executeRawUnsafe(CHAT_SCHEMA_SQL);
        await prisma.$executeRawUnsafe(`
          IF COL_LENGTH('dbo.job_card_chats', 'last_message_status') IS NULL
          BEGIN
            ALTER TABLE dbo.job_card_chats ADD last_message_status NVARCHAR(20) NULL;
          END
        `);
      } catch (err) {
        console.warn('[Chat] Schema ensure notice:', err.message);
      }
    })();
  }
  return schemaPromise;
};

const resolveJobCard = async (identifier) => {
  const rawId = String(identifier || '').trim();
  if (!rawId) return null;

  const parsedId = Number(rawId);
  const isNumeric = Number.isInteger(parsedId) && parsedId > 0;

  const conditions = [
    { slug: rawId },
    { slug: rawId.toLowerCase() },
    { jobCardNo: rawId },
    { jobCardNo: rawId.toUpperCase() }
  ];

  if (isNumeric) {
    conditions.push({ id: parsedId });
  }

  return prisma.jobCard.findFirst({
    where: { OR: conditions },
    include: {
      customer: true,
      vehicle: {
        include: { brand: true }
      }
    }
  });
};

const syncExistingApprovalsToChat = async (jobCard, existingRow, currentMessages) => {
  try {
    const approvals = await prisma.jobCardApproval.findMany({
      where: {
        jobCardId: jobCard.id,
        approvalType: 'ADDITIONAL_WORK'
      },
      include: {
        services: {
          include: {
            serviceItem: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    if (!approvals || approvals.length === 0) return currentMessages;

    let updated = false;
    let mergedMessages = [...currentMessages];

    for (const approval of approvals) {
      if (!approval.approvalCode) continue;

      const hasRequest = mergedMessages.some(m => m.text && m.text.includes(approval.approvalCode));
      if (!hasRequest) {
        const customerName = jobCard.customer?.fullName || 'Customer';
        const vehicleNo = jobCard.vehicle?.registrationNo || 'your vehicle';
        const serviceLines = (approval.services || []).map((service, index) => {
          const lineTotal = Number(service.price || 0) * Number(service.quantity || 1);
          const serviceName = service.serviceItem?.name || service.serviceName || service.name || 'Service';
          return `${index + 1}. ${serviceName} x${service.quantity || 1} - Rs. ${lineTotal.toLocaleString('en-IN')}`;
        });

        const approvalMessageText = [
          'Additional Work Approval Required 🔧',
          `Hello ${customerName}, your vehicle ${vehicleNo} needs approval for additional work.`,
          '',
          `Job Card: ${jobCard.jobCardNo}`,
          `Approval Code: ${approval.approvalCode}`,
          '',
          'Services Required:',
          ...serviceLines,
          '',
          approval.mechanicExplanation ? `Mechanic Note: ${approval.mechanicExplanation}` : null,
          `Total Amount: Rs. ${Number(approval.totalAmount || 0).toLocaleString('en-IN')}`
        ].filter(Boolean).join('\n');

        const requestMessage = {
          id: `aw-${approval.id}-${approval.approvalCode}`,
          sender: 'ADVISOR',
          senderName: 'Service Advisor',
          text: approvalMessageText,
          mediaUrl: approval.voice_note_url || null,
          time: (approval.sentAt || approval.createdAt || new Date()).toISOString()
        };

        mergedMessages.push(requestMessage);
        updated = true;
      }

      if (approval.customerResponse && approval.respondedAt) {
        const hasResponse = mergedMessages.some(m =>
          m.sender === 'CUSTOMER' &&
          (m.text === approval.customerResponse || (approval.approvalCode && m.text && m.text.includes(approval.approvalCode)))
        );
        if (!hasResponse) {
          const responseMessage = {
            id: `aw-res-${approval.id}`,
            sender: 'CUSTOMER',
            senderName: jobCard.customer?.fullName || 'Customer',
            text: approval.customerResponse,
            time: approval.respondedAt.toISOString()
          };
          mergedMessages.push(responseMessage);
          updated = true;
        }
      }
    }

    if (updated) {
      mergedMessages.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
      const lastMsg = mergedMessages[mergedMessages.length - 1];
      const updatedJson = JSON.stringify(mergedMessages);
      const now = new Date();

      if (existingRow) {
        await prisma.$executeRawUnsafe(
          `UPDATE dbo.job_card_chats
           SET messages_json = @P1,
               last_message_text = @P2,
               last_sender_type = @P3,
               last_message_at = @P4,
               updated_at = @P5
           WHERE job_card_id = @P6`,
          updatedJson,
          String(lastMsg?.text || '').substring(0, 490),
          lastMsg?.sender || 'SYSTEM',
          lastMsg?.time ? new Date(lastMsg.time) : now,
          now,
          jobCard.id
        );
      } else {
        await prisma.$executeRawUnsafe(
          `INSERT INTO dbo.job_card_chats (
             job_card_id, customer_id, customer_mobile, unread_count,
             last_message_text, last_sender_type, last_message_at,
             messages_json, created_at, updated_at
           ) VALUES (@P1, @P2, @P3, @P4, @P5, @P6, @P7, @P8, @P9, @P10)`,
          jobCard.id,
          jobCard.customerId || 0,
          jobCard.customer?.mobileNo || '',
          0,
          String(lastMsg?.text || '').substring(0, 490),
          lastMsg?.sender || 'SYSTEM',
          lastMsg?.time ? new Date(lastMsg.time) : now,
          updatedJson,
          now,
          now
        );
      }
    }

    return mergedMessages;
  } catch (err) {
    console.warn('[Chat] Failed to sync approvals to chat:', err.message);
    return currentMessages;
  }
};

const getChatByJobCard = async (identifier) => {
  await ensureChatSchema();
  const jobCard = await resolveJobCard(identifier);
  if (!jobCard) {
    const error = new Error('Job Card not found');
    error.statusCode = 404;
    throw error;
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, job_card_id, customer_id, customer_mobile, unread_count, last_message_text, last_sender_type, last_message_at, messages_json
     FROM dbo.job_card_chats WHERE job_card_id = @P1`,
    jobCard.id
  );

  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  let messages = [];
  if (row && row.messages_json) {
    try {
      messages = typeof row.messages_json === 'string' ? JSON.parse(row.messages_json) : row.messages_json;
    } catch {
      messages = [];
    }
  }

  messages = await syncExistingApprovalsToChat(jobCard, row, Array.isArray(messages) ? messages : []);
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

  // Dynamically sign media URLs with fresh 24-hour SAS tokens (matching vehicle & job card modules)
  const signedMessages = (Array.isArray(messages) ? messages : []).map(msg => {
    if (msg && (msg.mediaUrl || msg.blobName)) {
      const freshUrl = signChatMessageMediaUrl(msg.mediaUrl, msg.blobName, 86400); // 24 hours
      return {
        ...msg,
        mediaUrl: freshUrl
      };
    }
    return msg;
  });

  return {
    jobCardId: jobCard.id,
    jobCardNo: jobCard.jobCardNo,
    slug: jobCard.slug,
    customerId: jobCard.customerId,
    customerName: jobCard.customer?.fullName || 'Customer',
    customerMobile: jobCard.customer?.mobileNo || row?.customer_mobile || '',
    vehicleNo: jobCard.vehicle?.registrationNo || '',
    unreadCount: row?.unread_count || 0,
    lastMessageText: lastMsg ? lastMsg.text : (row?.last_message_text || null),
    lastSenderType: lastMsg ? lastMsg.sender : (row?.last_sender_type || null),
    lastMessageStatus: lastMsg ? lastMsg.status : (row?.last_message_status || null),
    lastMessageAt: lastMsg?.time ? new Date(lastMsg.time) : (row?.last_message_at || null),
    messages: signedMessages
  };
};

const addMessageToChat = async ({
  jobCardId,
  customerId,
  customerMobile,
  senderType,
  senderName,
  text,
  mediaUrl,
  mediaType,
  fileName,
  twilioSid,
  status
}) => {
  await ensureChatSchema();

  const cleanText = String(text || '').trim();
  if (!cleanText && !mediaUrl) {
    return null;
  }

  const numericJobCardId = Number(jobCardId);
  const numericCustomerId = Number(customerId || 0);
  const cleanMobile = String(customerMobile || '').trim();

  let detectedMediaType = mediaType;
  if (!detectedMediaType && mediaUrl) {
    if (mediaUrl.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
      detectedMediaType = 'image';
    } else if (mediaUrl.match(/\.(pdf|doc|docx|txt)/i)) {
      detectedMediaType = 'document';
    } else {
      detectedMediaType = 'audio';
    }
  }

  let summaryText = cleanText;
  if (!summaryText && mediaUrl) {
    if (detectedMediaType === 'image') {
      summaryText = '📷 Photo';
    } else if (detectedMediaType === 'document') {
      summaryText = `📄 ${fileName || 'Document'}`;
    } else {
      summaryText = '🎤 Voice message';
    }
  }

  const provider = getStorageProvider();
  const extractedBlobName = extractBlobNameFromUrl(mediaUrl, provider?.config?.container);

  const initialStatus = status || (senderType === 'ADVISOR' ? 'sent' : 'delivered');

  const newMessage = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    sender: senderType, // 'CUSTOMER' | 'ADVISOR' | 'SYSTEM'
    senderName: senderName || (senderType === 'CUSTOMER' ? 'Customer' : 'Service Advisor'),
    text: cleanText,
    mediaUrl: mediaUrl || null,
    mediaType: detectedMediaType || null,
    fileName: fileName || null,
    blobName: extractedBlobName || null,
    time: new Date().toISOString(),
    twilioSid: twilioSid || null,
    status: initialStatus
  };

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, messages_json, unread_count FROM dbo.job_card_chats WHERE job_card_id = @P1`,
    numericJobCardId
  );

  let currentMessages = [];
  let existingRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

  if (existingRow && existingRow.messages_json) {
    try {
      currentMessages = typeof existingRow.messages_json === 'string'
        ? JSON.parse(existingRow.messages_json)
        : existingRow.messages_json;
    } catch {
      currentMessages = [];
    }
  }

  currentMessages.push(newMessage);
  const updatedJson = JSON.stringify(currentMessages);
  const isCustomer = senderType === 'CUSTOMER';
  const newUnreadCount = isCustomer ? (Number(existingRow?.unread_count || 0) + 1) : 0;
  const now = new Date();

  if (existingRow) {
    await prisma.$executeRawUnsafe(
      `UPDATE dbo.job_card_chats
       SET messages_json = @P1,
           last_message_text = @P2,
           last_sender_type = @P3,
           last_message_at = @P4,
           unread_count = @P5,
           updated_at = @P6,
           last_message_status = @P7
       WHERE job_card_id = @P8`,
      updatedJson,
      summaryText.substring(0, 490),
      senderType,
      now,
      newUnreadCount,
      now,
      newMessage.status,
      numericJobCardId
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO dbo.job_card_chats (
         job_card_id, customer_id, customer_mobile, unread_count,
         last_message_text, last_sender_type, last_message_at,
         messages_json, created_at, updated_at, last_message_status
       ) VALUES (@P1, @P2, @P3, @P4, @P5, @P6, @P7, @P8, @P9, @P10, @P11)`,
      numericJobCardId,
      numericCustomerId,
      cleanMobile,
      isCustomer ? 1 : 0,
      summaryText.substring(0, 490),
      senderType,
      now,
      updatedJson,
      now,
      now,
      newMessage.status
    );
  }

  let jobCardLocationId = null;
  try {
    const jc = await prisma.jobCard.findUnique({
      where: { id: numericJobCardId },
      select: { locationId: true }
    });
    jobCardLocationId = jc?.locationId || null;
  } catch {}

  // Real-time broadcast via Socket.IO
  const io = getSocket();
  if (io) {
    const payload = {
      jobCardId: numericJobCardId,
      locationId: jobCardLocationId,
      message: newMessage,
      unreadCount: newUnreadCount,
      lastMessageAt: now
    };
    io.to(`chat:job_card_${numericJobCardId}`).emit('chat:new_message', payload);
    io.emit('chat:updated', payload);
  }

  return {
    jobCardId: numericJobCardId,
    message: newMessage,
    unreadCount: newUnreadCount
  };
};

const sendAdvisorReply = async ({
  jobCardId,
  text,
  audioData,
  mediaUrl,
  fileData,
  fileName,
  fileType,
  userId,
  userName
}) => {
  const jobCard = await resolveJobCard(jobCardId);
  if (!jobCard) {
    const error = new Error('Job Card not found');
    error.statusCode = 404;
    throw error;
  }

  const customerMobile = jobCard.customer?.mobileNo;
  if (!customerMobile) {
    const error = new Error('Customer mobile number is missing for this Job Card');
    error.statusCode = 400;
    throw error;
  }

  let resolvedMediaUrl = mediaUrl || null;
  let resolvedMediaType = fileType || null;
  let resolvedFileName = fileName || null;

  if (audioData && typeof audioData === 'string' && audioData.startsWith('data:')) {
    try {
      const { createStorageProvider } = require('../../providers/storage/storage.provider');
      const storageProvider = createStorageProvider();
      resolvedMediaUrl = await storageProvider.uploadDataUrl(audioData, 'chat-audio');
      resolvedMediaType = 'audio';
    } catch (uploadErr) {
      console.error('[Chat Voice Note] Upload to storage failed:', uploadErr);
      const error = new Error('Failed to upload voice note: ' + (uploadErr?.message || 'Storage error'));
      error.statusCode = 500;
      throw error;
    }
  } else if (fileData && typeof fileData === 'string' && fileData.startsWith('data:')) {
    try {
      const { createStorageProvider } = require('../../providers/storage/storage.provider');
      const storageProvider = createStorageProvider();
      const isImg = fileType === 'image' || fileData.startsWith('data:image/') || (fileName && /\.(jpg|jpeg|png|webp|gif)$/i.test(fileName));
      const folder = isImg ? 'chat-images' : 'chat-documents';
      resolvedMediaUrl = await storageProvider.uploadDataUrl(fileData, folder, { fileName });
      resolvedMediaType = isImg ? 'image' : 'document';
      resolvedFileName = fileName || (isImg ? 'Photo' : 'Document');
    } catch (uploadErr) {
      console.error('[Chat Media Attachment] Upload to storage failed:', uploadErr);
      const error = new Error('Failed to upload attachment: ' + (uploadErr?.message || 'Storage error'));
      error.statusCode = 500;
      throw error;
    }
  }

  const cleanText = String(text || '').trim();
  if (!cleanText && !resolvedMediaUrl) {
    const error = new Error('Message text or file attachment is required');
    error.statusCode = 400;
    throw error;
  }

  const isSandbox = (env.twilio.whatsappFrom || '').includes('+14155238886');
  const targetMobile = (isSandbox && env.twilio.testMobile)
    ? env.twilio.testMobile
    : (customerMobile || env.twilio.testMobile || '9952656498');

  // WhatsApp Message Body
  let fallbackBody = cleanText;
  if (!fallbackBody) {
    if (resolvedMediaType === 'image') fallbackBody = 'Photo';
    else if (resolvedMediaType === 'document') fallbackBody = resolvedFileName || 'Document';
    else if (resolvedMediaType === 'audio') fallbackBody = 'Voice message';
    else fallbackBody = 'Attachment';
  }

  // 1. Send to WhatsApp via Twilio
  let twilioRes = null;
  try {
    twilioRes = await sendWhatsAppMessage({
      to: targetMobile,
      body: fallbackBody,
      mediaUrl: resolvedMediaUrl ? [resolvedMediaUrl] : undefined
    });
  } catch (twErr) {
    console.warn('[Chat] WhatsApp message delivery notice (persisting to chat):', twErr?.message || twErr);
  }

  // 2. Persist in Chat History with the REAL customer's mobile and details for display
  const result = await addMessageToChat({
    jobCardId: jobCard.id,
    customerId: jobCard.customerId,
    customerMobile: customerMobile,
    senderType: 'ADVISOR',
    senderName: userName || 'Service Advisor',
    text: cleanText,
    mediaUrl: resolvedMediaUrl,
    mediaType: resolvedMediaType,
    fileName: resolvedFileName,
    twilioSid: twilioRes?.sid || null,
    status: twilioRes?.status === 'delivered' ? 'delivered' : 'sent'
  });

  return result;
};

const updateMessageStatusByTwilioSid = async (twilioSid, incomingStatus) => {
  if (!twilioSid) return false;
  await ensureChatSchema();

  const cleanSid = String(twilioSid).trim();
  const rawStatus = String(incomingStatus || '').toLowerCase().trim();

  // Normalize status to 'sent' | 'delivered' | 'read' | 'failed'
  let normalizedStatus = 'sent';
  if (rawStatus === 'read') {
    normalizedStatus = 'read';
  } else if (rawStatus === 'delivered') {
    normalizedStatus = 'delivered';
  } else if (rawStatus === 'sent' || rawStatus === 'queued' || rawStatus === 'sending') {
    normalizedStatus = 'sent';
  } else if (rawStatus === 'failed' || rawStatus === 'undelivered') {
    normalizedStatus = 'failed';
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, job_card_id, messages_json FROM dbo.job_card_chats WHERE messages_json LIKE @P1`,
      `%${cleanSid}%`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    const row = rows[0];
    let messages = [];
    try {
      messages = typeof row.messages_json === 'string'
        ? JSON.parse(row.messages_json)
        : row.messages_json;
    } catch {
      return false;
    }

    let updated = false;
    let targetMessageId = null;
    let isLastMsg = false;

    // Priority ranking so we never regress status (e.g. delivered after read)
    const statusPriority = {
      failed: 0,
      sent: 1,
      delivered: 2,
      read: 3
    };

    messages = messages.map((msg, idx) => {
      if (msg && msg.twilioSid === cleanSid) {
        targetMessageId = msg.id;
        if (idx === messages.length - 1) {
          isLastMsg = true;
        }
        const currentRank = statusPriority[msg.status] || 1;
        const newRank = statusPriority[normalizedStatus] || 1;

        if (newRank >= currentRank) {
          updated = true;
          return {
            ...msg,
            status: normalizedStatus
          };
        }
      }
      return msg;
    });

    if (updated) {
      const updatedJson = JSON.stringify(messages);
      if (isLastMsg) {
        await prisma.$executeRawUnsafe(
          `UPDATE dbo.job_card_chats SET messages_json = @P1, last_message_status = @P2, updated_at = SYSUTCDATETIME() WHERE id = @P3`,
          updatedJson,
          normalizedStatus,
          row.id
        );
      } else {
        await prisma.$executeRawUnsafe(
          `UPDATE dbo.job_card_chats SET messages_json = @P1, updated_at = SYSUTCDATETIME() WHERE id = @P2`,
          updatedJson,
          row.id
        );
      }

      // Emit real-time status update to frontend
      const io = getSocket();
      if (io) {
        const payload = {
          jobCardId: row.job_card_id,
          messageId: targetMessageId,
          twilioSid: cleanSid,
          status: normalizedStatus
        };
        io.to(`chat:job_card_${row.job_card_id}`).emit('chat:message_status_updated', payload);
        io.emit('chat:message_status_updated', payload);
        io.emit('chat:updated', payload);
      }
      return true;
    }
  } catch (err) {
    console.warn('[Chat] Failed to update message status by Twilio SID:', err.message);
  }

  return false;
};

const markChatAsRead = async (identifier) => {
  await ensureChatSchema();
  const jobCard = await resolveJobCard(identifier);
  if (!jobCard) return { success: false };

  await prisma.$executeRawUnsafe(
    `UPDATE dbo.job_card_chats SET unread_count = 0 WHERE job_card_id = @P1`,
    jobCard.id
  );

  const io = getSocket();
  if (io) {
    io.to(`chat:job_card_${jobCard.id}`).emit('chat:read', { jobCardId: jobCard.id, locationId: jobCard.locationId });
    io.emit('chat:unread_cleared', { jobCardId: jobCard.id, locationId: jobCard.locationId });
  }

  return { success: true, jobCardId: jobCard.id };
};

const findActiveJobCardByMobile = async (rawMobile) => {
  const digits = String(rawMobile || '').replace(/\D/g, '');
  const mobile10 = digits.length >= 10 ? digits.slice(-10) : digits;

  let jobCard = null;
  if (mobile10) {
    jobCard = await prisma.jobCard.findFirst({
      where: {
        customer: {
          OR: [
            { mobileNo: { contains: mobile10 } },
            { alternateMobileNo: { contains: mobile10 } }
          ]
        }
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: true,
        vehicle: true
      }
    });
  }

  // Sandbox fallback: in trial mode, if incoming message doesn't match an exact customer, route to latest active job card
  if (!jobCard) {
    jobCard = await prisma.jobCard.findFirst({
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: true,
        vehicle: true
      }
    });
  }

  return jobCard;
};

const listRecentChats = async ({ locationId, search, unreadOnly, limit = 50 } = {}) => {
  await ensureChatSchema();

  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (locationId) {
    conditions.push(`j.location_id = @P${paramIndex++}`);
    params.push(Number(locationId));
  }

  if (unreadOnly) {
    conditions.push(`c.unread_count > 0`);
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    const p1 = paramIndex++;
    const p2 = paramIndex++;
    const p3 = paramIndex++;
    const p4 = paramIndex++;
    conditions.push(`(
      cust.full_name LIKE @P${p1} OR
      c.customer_mobile LIKE @P${p2} OR
      v.registration_no LIKE @P${p3} OR
      j.job_card_no LIKE @P${p4}
    )`);
    params.push(s, s, s, s);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT TOP (${Number(limit) || 50})
      c.id,
      c.job_card_id AS jobCardId,
      c.customer_id AS customerId,
      c.customer_mobile AS customerMobile,
      c.unread_count AS unreadCount,
      c.last_message_text AS lastMessageText,
      c.last_sender_type AS lastSenderType,
      c.last_message_status AS lastMessageStatus,
      c.last_message_at AS lastMessageAt,
      j.job_card_no AS jobCardNo,
      j.location_id AS locationId,
      cust.full_name AS customerName,
      v.registration_no AS vehicleNo,
      b.name AS vehicleBrand
    FROM dbo.job_card_chats c
    INNER JOIN dbo.job_cards j ON c.job_card_id = j.id
    LEFT JOIN dbo.customers cust ON c.customer_id = cust.id
    LEFT JOIN dbo.vehicles v ON j.vehicle_id = v.id
    LEFT JOIN dbo.vehicle_brands b ON v.brand_id = b.id
    ${whereClause}
    ORDER BY c.last_message_at DESC
  `;

  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    console.error('[Chat] Failed to list recent chats:', err);
    rows = [];
  }

  let totalUnreadCount = 0;
  try {
    let unreadCountSql = `
      SELECT COALESCE(SUM(c.unread_count), 0) AS totalUnread
      FROM dbo.job_card_chats c
      INNER JOIN dbo.job_cards j ON c.job_card_id = j.id
    `;
    const unreadParams = [];
    if (locationId) {
      unreadCountSql += ` WHERE j.location_id = @P1`;
      unreadParams.push(Number(locationId));
    }
    const unreadRows = await prisma.$queryRawUnsafe(unreadCountSql, ...unreadParams);
    totalUnreadCount = unreadRows?.[0]?.totalUnread ? Number(unreadRows[0].totalUnread) : 0;
  } catch (unreadErr) {
    console.warn('[Chat] Failed to count total unread:', unreadErr);
  }

  return {
    totalUnreadCount,
    chats: (rows || []).map((r) => ({
      id: r.id,
      jobCardId: r.jobCardId,
      jobCardNo: r.jobCardNo || '',
      customerId: r.customerId,
      customerName: r.customerName || 'Customer',
      customerMobile: r.customerMobile || '',
      vehicleNo: r.vehicleNo || 'N/A',
      vehicleBrand: r.vehicleBrand || '',
      unreadCount: Number(r.unreadCount || 0),
      lastMessageText: r.lastMessageText || '',
      lastSenderType: r.lastSenderType || 'SYSTEM',
      lastMessageStatus: r.lastMessageStatus || null,
      lastMessageAt: r.lastMessageAt
    }))
  };
};

module.exports = {
  ensureChatSchema,
  getChatByJobCard,
  addMessageToChat,
  sendAdvisorReply,
  updateMessageStatusByTwilioSid,
  markChatAsRead,
  findActiveJobCardByMobile,
  listRecentChats
};
