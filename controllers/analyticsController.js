/**
 * Analytics Controller — Frontend-initiated event tracking
 *
 * Handles page views, UTM capture, and client-side analytics events
 * that the frontend emits independently of API calls (e.g. page_viewed,
 * section_impressed, search_bar_used).
 *
 * @version 1.0.0
 */

const { enqueueEvent } = require('../utils/queue');
const { deriveSessionId } = require('../utils/eventEmitter');
const catchAsync = require('../utils/catchAsync');

/**
 * POST /api/analytics/event
 *
 * Generic event ingestion endpoint. The frontend sends structured
 * event payloads here for any client-side action that doesn't have
 * a corresponding backend API call.
 *
 * Body: { name, properties?, resourceId?, resource? }
 */
exports.trackEvent = catchAsync(async (req, res) => {
  const { name, properties, resourceId, resource } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ status: 'fail', message: 'Event name is required' });
  }

  // Whitelist allowed event names to prevent abuse
  const ALLOWED_EVENTS = [
    'page_viewed',
    'section_impressed',
    'search_bar_used',
    'tour_card_clicked',
    'mood_keyword_clicked',
    'location_shared',
    'external_referrer_captured',
  ];

  if (!ALLOWED_EVENTS.includes(name)) {
    return res.status(400).json({ status: 'fail', message: `Unknown event: ${name}` });
  }

  const sessionId = deriveSessionId(req);

  enqueueEvent({
    name,
    userId: req.user?.id || null,
    sessionId,
    source: 'web',
    resource: resource || null,
    resourceId: resourceId || null,
    properties: {
      ...properties,
      userAgent: req.headers['user-agent'] || null,
      referrer: req.headers['referer'] || properties?.referrer || null,
    },
  });

  res.status(202).json({ status: 'success', message: 'Event queued' });
});

/**
 * POST /api/analytics/batch
 *
 * Batch event ingestion — the frontend can send multiple events at once
 * (e.g. on page unload or at regular intervals).
 *
 * Body: { events: [{ name, properties?, resourceId?, resource? }] }
 */
exports.trackBatch = catchAsync(async (req, res) => {
  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ status: 'fail', message: 'Events array is required' });
  }

  if (events.length > 20) {
    return res.status(400).json({ status: 'fail', message: 'Max 20 events per batch' });
  }

  const sessionId = deriveSessionId(req);
  const userId = req.user?.id || null;

  const ALLOWED_EVENTS = [
    'page_viewed',
    'section_impressed',
    'search_bar_used',
    'tour_card_clicked',
    'mood_keyword_clicked',
    'location_shared',
    'external_referrer_captured',
  ];

  for (const evt of events) {
    if (!evt.name || !ALLOWED_EVENTS.includes(evt.name)) continue;

    enqueueEvent({
      name: evt.name,
      userId,
      sessionId,
      source: 'web',
      resource: evt.resource || null,
      resourceId: evt.resourceId || null,
      properties: {
        ...evt.properties,
        referrer: req.headers['referer'] || evt.properties?.referrer || null,
      },
    });
  }

  res.status(202).json({ status: 'success', message: `${events.length} events queued` });
});
