let io = null;

const TRACKED_MODELS = new Set([
  'Tour',
  'User',
  'SupplierProfile',
  'Booking',
  'Payout',
  'PayoutMethod',
  'Review',
  'AdminNotification',
]);

function setIO(socketIO) {
  io = socketIO;
}

function emitDataChange(modelName, action, recordId) {
  if (!io) return;
  io.to('admin-room').emit('data-change', {
    model: modelName,
    action,
    recordId,
    timestamp: new Date().toISOString(),
  });
}

const EVENT_MAP = {
  'User.create':         'admin:signup',
  'Booking.create':      'admin:new-booking',
  'Review.create':       'admin:new-review',
  'Payout.update':       'admin:payout-update',
  'SupplierProfile.create': 'admin:supplier-application',
  'SupplierProfile.update': 'admin:supplier-status-change',
  'AdminNotification.create': 'admin:notification',
  'Tour.create':         'admin:new-tour',
  'Tour.update':         'admin:tour-update',
};

function emitModelEvent(modelName, action, recordId) {
  if (!io) return;
  const key = `${modelName}.${action}`;
  const eventName = EVENT_MAP[key];
  if (eventName) {
    io.to('admin-room').emit(eventName, {
      model: modelName,
      action,
      recordId,
      timestamp: new Date().toISOString(),
    });
  }
}

function setupPrismaMiddleware(prisma) {
  prisma.$use(async (params, next) => {
    const result = await next(params);

    if (TRACKED_MODELS.has(params.model)) {
      if (params.action === 'create' || params.action === 'update' || params.action === 'delete' || params.action === 'updateMany' || params.action === 'deleteMany') {
        const recordId = params.args?.where?.id || result?.id || null;
        setImmediate(() => {
          emitDataChange(params.model, params.action, recordId);
          emitModelEvent(params.model, params.action, recordId);
        });
      }
    }

    return result;
  });

  console.log(`[dataChangeEmitter] Prisma middleware installed (tracking ${TRACKED_MODELS.size} models)`);
}

module.exports = { setIO, setupPrismaMiddleware, emitDataChange };
