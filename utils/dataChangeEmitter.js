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

function setupPrismaMiddleware(prisma) {
  prisma.$use(async (params, next) => {
    const result = await next(params);

    if (TRACKED_MODELS.has(params.model)) {
      if (params.action === 'create' || params.action === 'update' || params.action === 'delete' || params.action === 'updateMany' || params.action === 'deleteMany') {
        const recordId = params.args?.where?.id || result?.id || null;
        setImmediate(() => {
          emitDataChange(params.model, params.action, recordId);
        });
      }
    }

    return result;
  });

  console.log(`[dataChangeEmitter] Prisma middleware installed (tracking ${TRACKED_MODELS.size} models)`);
}

module.exports = { setIO, setupPrismaMiddleware, emitDataChange };
