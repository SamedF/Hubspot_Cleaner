require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));

const config = buildConfig();
validateConfig(config);

const processedEvents = new Map();
const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com',
  timeout: config.requestTimeoutMs,
  headers: {
    Authorization: `Bearer ${config.hubspotToken}`,
    'Content-Type': 'application/json'
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    dryRun: config.dryRun,
    action: config.action,
    processedEventCacheSize: processedEvents.size
  });
});

app.post('/webhooks/hubspot', async (req, res) => {
  if (!isValidHubSpotSignatureV3(req, config.clientSecret)) {
    return res.status(401).json({ ok: false, error: 'Invalid HubSpot signature' });
  }

  const events = Array.isArray(req.body) ? req.body : [];
  res.status(200).json({ ok: true, received: events.length });

  for (const event of events) {
    try {
      await processEvent(event);
    } catch (error) {
      log('error', 'Failed to process event', {
        error: error.message,
        stack: error.stack,
        eventSummary: summarizeEvent(event)
      });
    }
  }
});

async function processEvent(event) {
  if (!event || event.subscriptionType !== 'conversation.newMessage') {
    return;
  }

  const threadId = String(event.objectId || '');
  const messageId = String(event.messageId || '');
  if (!threadId) {
    log('warn', 'Skipped event because threadId is missing', { eventSummary: summarizeEvent(event) });
    return;
  }

  const eventKey = buildEventKey(event);
  if (isDuplicateEvent(eventKey)) {
    log('info', 'Skipped duplicate webhook event', { threadId, messageId, eventKey });
    return;
  }
  rememberEvent(eventKey);

  const thread = await getThread(threadId);
  if (!thread) {
    log('warn', 'Thread not found', { threadId, messageId });
    return;
  }

  if (config.ignoreInboxIds.includes(String(thread.inboxId || ''))) {
    log('info', 'Skipped thread because inbox is ignored', { threadId, inboxId: thread.inboxId });
    return;
  }

  const threadChannelId = String(thread.channelId || thread.originalChannelId || '');
  if (config.ignoreChannelIds.includes(threadChannelId)) {
    log('info', 'Skipped thread because channel is ignored', { threadId, channelId: threadChannelId });
    return;
  }

  let targetMessage = messageId
    ? await getMessage(threadId, messageId)
    : await getLatestMessage(threadId);

  if (targetMessage && isHubSpotNotificationMessage(targetMessage)) {
    log('info', 'Webhook message looks like HubSpot notification, scanning thread for real inbound email', {
      threadId,
      messageId: targetMessage.id || messageId,
      subject: targetMessage.subject || null,
      senders: extractSenderValues(targetMessage)
    });

    const messages = await getMessages(threadId);
    const fallbackMessage = findRealInboundCandidate(messages);

    if (fallbackMessage) {
      targetMessage = fallbackMessage;
      log('info', 'Using fallback inbound message from thread scan', {
        threadId,
        originalMessageId: messageId,
        fallbackMessageId: fallbackMessage.id || null,
        subject: fallbackMessage.subject || null,
        senders: extractSenderValues(fallbackMessage)
      });
    }
  }

  if (!targetMessage) {
    log('warn', 'No target message found for thread', { threadId, messageId });
    return;
  }

  if (String(targetMessage.direction || '').toUpperCase() !== 'INCOMING') {
    log('info', 'Skipped because webhook message is not incoming', {
      threadId,
      messageId: targetMessage.id || messageId,
      direction: targetMessage.direction || null
    });
    return;
  }

  const content = await getMessageContent(threadId, targetMessage);
  const decision = shouldHandleMessage(thread, targetMessage, content);

  if (!decision.shouldHandle) {
    log('info', 'Message did not match action criteria', {
      threadId,
      messageId: targetMessage.id || messageId,
      reason: decision.reason,
      subject: targetMessage.subject || null,
      senders: extractSenderValues(targetMessage),
      action: config.action
    });
    return;
  }

  const audit = {
    threadId,
    messageId: String(targetMessage.id || messageId || ''),
    reason: decision.reason,
    subject: targetMessage.subject || null,
    senders: extractSenderValues(targetMessage),
    action: config.action,
    dryRun: config.dryRun
  };

  if (config.dryRun) {
    log('info', `DRY RUN: would ${config.action} thread`, audit);
    return;
  }

  if (config.action === 'close') {
    await closeThread(threadId);
    log('info', 'Closed thread', audit);
    return;
  }

  await archiveThread(threadId);
  log('info', 'Archived thread', audit);
}

function shouldHandleMessage(thread, message, content) {
  const hasIcs = hasIcsAttachment(message);

  if (config.requireIcs && !hasIcs) {
    return { shouldHandle: false, reason: 'No .ics attachment' };
  }

  const subject = String(message.subject || '');
  const bodyText = stripHtml(`${content.text || ''}\n${content.richText || ''}`);
  const senders = extractSenderValues(message).join(' | ');

  const senderMatch = matchesAnyRegex(senders, config.archiveIfSenderMatches);
  const subjectMatch = matchesAnyRegex(subject, config.archiveIfSubjectMatches);
  const bodyMatch = matchesAnyRegex(bodyText, config.archiveIfBodyMatches);

  const hasRegexFilters = Boolean(
    config.archiveIfSenderMatches.length ||
    config.archiveIfSubjectMatches.length ||
    config.archiveIfBodyMatches.length
  );

  if (hasRegexFilters && !(senderMatch || subjectMatch || bodyMatch)) {
    return { shouldHandle: false, reason: 'Configured regex filters did not match' };
  }

  if (config.onlyIfThreadOpen && String(thread.status || '').toUpperCase() === 'CLOSED') {
    return { shouldHandle: false, reason: 'Thread is already closed' };
  }

  return {
    shouldHandle: hasIcs || !config.requireIcs,
    reason: [
      hasIcs ? '.ics attachment' : null,
      senderMatch ? 'sender regex matched' : null,
      subjectMatch ? 'subject regex matched' : null,
      bodyMatch ? 'body regex matched' : null,
      !hasRegexFilters ? 'default rule' : null
    ].filter(Boolean).join(', ')
  };
}

function isIcsAttachment(file) {
  const name = String(file?.name || '').toLowerCase();
  const url = String(file?.url || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  const usageType = String(file?.fileUsageType || '').toLowerCase();
  return (
    name.endsWith('.ics') ||
    url.includes('.ics') ||
    type.includes('calendar') ||
    usageType.includes('calendar')
  );
}

function extractSenderValues(message) {
  const senders = Array.isArray(message.senders) ? message.senders : [];
  return senders.map((sender) => {
    const identifier =
      sender?.deliveryIdentifier?.value ||
      sender?.actorId ||
      sender?.name ||
      sender?.senderField ||
      '';
    return String(identifier);
  }).filter(Boolean);
}

function normalizeSenders(message) {
  return extractSenderValues(message).map((value) => String(value || '').toLowerCase());
}

function isHubSpotNotificationMessage(message) {
  const senders = normalizeSenders(message);
  const subject = String(message?.subject || '').toLowerCase();

  return (
    senders.some((sender) => sender.includes('noreply@notifications.hubspot.com')) ||
    subject.startsWith('new email conversation from')
  );
}

function hasIcsAttachment(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return attachments.some(isIcsAttachment);
}

function findRealInboundCandidate(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return messages.find((message) => {
    const direction = String(message?.direction || '').toUpperCase();
    if (direction !== 'INCOMING') {
      return false;
    }

    if (isHubSpotNotificationMessage(message)) {
      return false;
    }

    return hasIcsAttachment(message);
  }) || null;
}

async function getThread(threadId) {
  const response = await hubspotRequest(() => hubspot.get(`/conversations/v3/conversations/threads/${threadId}`));
  return response.data || null;
}

async function getMessages(threadId) {
  const response = await hubspotRequest(() =>
    hubspot.get(`/conversations/v3/conversations/threads/${threadId}/messages`, {
      params: { limit: 20, sort: '-createdAt' }
    })
  );
  return response.data?.results || [];
}

async function getMessage(threadId, messageId) {
  const response = await hubspotRequest(() =>
    hubspot.get(`/conversations/v3/conversations/threads/${threadId}/messages/${messageId}`)
  );
  return response.data || null;
}

async function getLatestMessage(threadId) {
  const response = await hubspotRequest(() =>
    hubspot.get(`/conversations/v3/conversations/threads/${threadId}/messages`, {
      params: { limit: 1, sort: '-createdAt' }
    })
  );
  return response.data?.results?.[0] || null;
}

async function getOriginalMessageContent(threadId, messageId) {
  const response = await hubspotRequest(() =>
    hubspot.get(`/conversations/v3/conversations/threads/${threadId}/messages/${messageId}/original-content`)
  );
  return response.data || { text: '', richText: '' };
}

async function closeThread(threadId) {
  await hubspotRequest(() =>
    hubspot.patch(`/conversations/v3/conversations/threads/${threadId}`, { status: 'CLOSED' })
  );
}

async function archiveThread(threadId) {
  await hubspotRequest(() => hubspot.delete(`/conversations/v3/conversations/threads/${threadId}`));
}

async function getMessageContent(threadId, message) {
  const truncationStatus = String(message.truncationStatus || 'NOT_TRUNCATED').toUpperCase();
  if (truncationStatus === 'NOT_TRUNCATED') {
    return {
      text: String(message.text || ''),
      richText: String(message.richText || '')
    };
  }

  try {
    const original = await getOriginalMessageContent(threadId, message.id);
    return {
      text: String(original?.text || message.text || ''),
      richText: String(original?.richText || message.richText || '')
    };
  } catch (error) {
    log('warn', 'Falling back to truncated message content', {
      threadId,
      messageId: message.id,
      error: error.message
    });
    return {
      text: String(message.text || ''),
      richText: String(message.richText || '')
    };
  }
}

async function hubspotRequest(fn, attempt = 1) {
  try {
    return await fn();
  } catch (error) {
    const status = error?.response?.status;
    const shouldRetry = attempt < config.maxHubspotRetries && isRetryableStatus(status, error);

    if (!shouldRetry) {
      throw enrichAxiosError(error);
    }

    const delayMs = computeRetryDelayMs(attempt);
    log('warn', 'Retrying HubSpot request', {
      attempt,
      maxHubspotRetries: config.maxHubspotRetries,
      delayMs,
      status,
      error: error.message
    });
    await sleep(delayMs);
    return hubspotRequest(fn, attempt + 1);
  }
}

function isRetryableStatus(status, error) {
  if (!status && error?.code) {
    return true;
  }
  return [429, 500, 502, 503, 504].includes(Number(status));
}

function enrichAxiosError(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const extra = status ? ` (status ${status})` : '';
  const message = `${error.message || 'HubSpot request failed'}${extra}`;
  const enriched = new Error(message);
  enriched.original = error;
  enriched.status = status;
  enriched.data = data;
  return enriched;
}

function computeRetryDelayMs(attempt) {
  const base = Math.min(1000 * (2 ** (attempt - 1)), 8000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidHubSpotSignatureV3(req, clientSecret) {
  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];
  if (!signature || !timestamp) {
    return false;
  }

  const requestAge = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(requestAge) || requestAge > 5 * 60 * 1000) {
    return false;
  }

  const requestUri = getRequestUri(req);
  const sourceString = `${req.method}${requestUri}${req.rawBody || ''}${timestamp}`;
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(sourceString, 'utf8')
    .digest('base64');

  return safeCompare(expected, signature);
}

function getRequestUri(req) {
  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const originalUrl = decodeHubSpotUri(req.originalUrl || req.url || '/');
  return `${protocol}://${host}${originalUrl}`;
}

function decodeHubSpotUri(uri) {
  return uri
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/')
    .replace(/%3F/gi, '?')
    .replace(/%40/gi, '@')
    .replace(/%21/gi, '!')
    .replace(/%24/gi, '$')
    .replace(/%27/gi, "'")
    .replace(/%28/gi, '(')
    .replace(/%29/gi, ')')
    .replace(/%2A/gi, '*')
    .replace(/%2C/gi, ',')
    .replace(/%3B/gi, ';');
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function matchesAnyRegex(value, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(value);
    } catch (error) {
      log('warn', 'Invalid regex pattern ignored', { pattern, error: error.message });
      return false;
    }
  });
}

function splitCsv(value) {
  if (!value || String(value).trim() === '') {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return String(value).toLowerCase() === 'true';
}

function buildConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    hubspotToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    clientSecret: process.env.HUBSPOT_APP_CLIENT_SECRET,
    dryRun: toBoolean(process.env.DRY_RUN, true),
    action: normalizeAction(process.env.ACTION),
    requireIcs: toBoolean(process.env.REQUIRE_ICS_ATTACHMENT, true),
    onlyIfThreadOpen: toBoolean(process.env.ONLY_IF_THREAD_OPEN, true),
    archiveIfSenderMatches: splitCsv(process.env.SENDER_ALLOWLIST_REGEX),
    archiveIfSubjectMatches: splitCsv(process.env.SUBJECT_ALLOWLIST_REGEX),
    archiveIfBodyMatches: splitCsv(process.env.BODY_ALLOWLIST_REGEX),
    ignoreInboxIds: splitCsv(process.env.IGNORE_INBOX_IDS),
    ignoreChannelIds: splitCsv(process.env.IGNORE_CHANNEL_IDS),
    logLevel: normalizeLogLevel(process.env.LOG_LEVEL || 'info'),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
    maxHubspotRetries: Number(process.env.MAX_HUBSPOT_RETRIES || 3),
    dedupeTtlMs: Number(process.env.DEDUPE_TTL_MS || 24 * 60 * 60 * 1000)
  };
}

function validateConfig(currentConfig) {
  if (!currentConfig.hubspotToken) {
    throw new Error('Missing HUBSPOT_PRIVATE_APP_TOKEN');
  }
  if (!currentConfig.clientSecret) {
    throw new Error('Missing HUBSPOT_APP_CLIENT_SECRET');
  }
  if (!Number.isFinite(currentConfig.port) || currentConfig.port <= 0) {
    throw new Error('PORT must be a positive number');
  }
  if (!['archive', 'close'].includes(currentConfig.action)) {
    throw new Error('ACTION must be archive or close');
  }
  if (!['error', 'warn', 'info', 'debug'].includes(currentConfig.logLevel)) {
    throw new Error('LOG_LEVEL must be error, warn, info, or debug');
  }
  if (!Number.isFinite(currentConfig.requestTimeoutMs) || currentConfig.requestTimeoutMs < 1000) {
    throw new Error('REQUEST_TIMEOUT_MS must be at least 1000');
  }
  if (!Number.isFinite(currentConfig.maxHubspotRetries) || currentConfig.maxHubspotRetries < 1) {
    throw new Error('MAX_HUBSPOT_RETRIES must be at least 1');
  }
  if (!Number.isFinite(currentConfig.dedupeTtlMs) || currentConfig.dedupeTtlMs < 60000) {
    throw new Error('DEDUPE_TTL_MS must be at least 60000');
  }
}

function normalizeAction(value) {
  const normalized = String(value || 'close').trim().toLowerCase();
  return normalized === 'archive' ? 'archive' : 'close';
}

function normalizeLogLevel(value) {
  const normalized = String(value || 'info').trim().toLowerCase();
  return ['error', 'warn', 'info', 'debug'].includes(normalized) ? normalized : 'info';
}

function buildEventKey(event) {
  return [
    event.subscriptionType || '',
    event.objectId || '',
    event.messageId || '',
    event.occurredAt || event.attemptNumber || ''
  ].join(':');
}

function isDuplicateEvent(eventKey) {
  pruneProcessedEvents();
  return processedEvents.has(eventKey);
}

function rememberEvent(eventKey) {
  processedEvents.set(eventKey, Date.now() + config.dedupeTtlMs);
  pruneProcessedEvents();
}

function pruneProcessedEvents() {
  const now = Date.now();
  for (const [key, expiresAt] of processedEvents.entries()) {
    if (expiresAt <= now) {
      processedEvents.delete(key);
    }
  }
}

function summarizeEvent(event) {
  return {
    subscriptionType: event?.subscriptionType || null,
    objectId: event?.objectId || null,
    messageId: event?.messageId || null,
    occurredAt: event?.occurredAt || null,
    messageType: event?.messageType || null
  };
}

function log(level, message, extra = {}) {
  const order = ['error', 'warn', 'info', 'debug'];
  if (order.indexOf(level) > order.indexOf(config.logLevel)) {
    return;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }));
}

const server = app.listen(config.port, () => {
  log('info', 'HubSpot inbox cleaner started', {
    port: config.port,
    dryRun: config.dryRun,
    action: config.action
  });
});

function shutdown(signal) {
  log('info', 'Received shutdown signal', { signal });
  server.close(() => {
    log('info', 'Server stopped');
    process.exit(0);
  });

  setTimeout(() => {
    log('warn', 'Forcing shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
