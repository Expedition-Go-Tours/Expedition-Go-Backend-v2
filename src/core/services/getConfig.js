const prisma = require('./prismaClient');

const cache = {};
const CACHE_TTL = 60000;

async function getConfig(key, defaultValue = null) {
  const now = Date.now();
  if (cache[key] && now - cache[key].time < CACHE_TTL) {
    return cache[key].value;
  }
  try {
    const config = await prisma.systemConfig.findUnique({ where: { key } });
    const value = config ? config.value : defaultValue;
    cache[key] = { value, time: now };
    return value;
  } catch {
    return defaultValue;
  }
}

getConfig.clearCache = () => {
  Object.keys(cache).forEach(k => delete cache[k]);
};

module.exports = getConfig;
