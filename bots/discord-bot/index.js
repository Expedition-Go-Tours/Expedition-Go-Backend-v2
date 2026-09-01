const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { execSync } = require('child_process');
const { Client: Pg } = require('pg');
const { callMimo } = require('../../utils/mimoClient');
const { validateReadOnly } = require('../../utils/sqlGuard');
require('dotenv').config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID;
const API_URL = process.env.API_URL || 'http://127.0.0.1:5000';
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/travio';
const AI_CHANNEL_ID = process.env.DISCORD_AI_CHANNEL_ID || null;

const pg = new Pg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });

// Connect pg eagerly so /ask and /chat don't hang on first query
pg.connect().catch((e) => console.warn('[bot] pg connect failed (will retry on first query):', e.message));

// Lazy Redis — only connects when /queue is used
let redis = null;
function getRedis() {
  if (redis) return redis;
  try {
    const IORedis = require('ioredis');
    redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
      enableOfflineQueue: true,
    });
    redis.connect().catch(() => {});
    return redis;
  } catch {
    return null;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder().setName('health').setDescription('API health (database + redis)'),
  new SlashCommandBuilder().setName('backup').setDescription('Latest PostgreSQL backup status'),
  new SlashCommandBuilder().setName('uptime').setDescription('Server uptime and load'),
  new SlashCommandBuilder().setName('disk').setDescription('Disk usage of root filesystem'),
  new SlashCommandBuilder()
    .setName('bookings')
    .setDescription('Booking summary')
    .addStringOption((o) =>
      o.setName('range').setDescription('today or week').setRequired(false)
    ),
  new SlashCommandBuilder().setName('digest').setDescription('Run the daily digest now'),
  new SlashCommandBuilder().setName('status').setDescription('Full ops status snapshot'),
  new SlashCommandBuilder()
    .setName('revenue')
    .setDescription('Revenue summary')
    .addStringOption((o) =>
      o.setName('range').setDescription('today, week, or month').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('payouts')
    .setDescription('Pending payout requests'),
  new SlashCommandBuilder()
    .setName('disputes')
    .setDescription('Open refund requests'),
  new SlashCommandBuilder()
    .setName('signups')
    .setDescription('New user and supplier signups')
    .addStringOption((o) =>
      o.setName('range').setDescription('today or week').setRequired(false)
    ),
  new SlashCommandBuilder().setName('cert').setDescription('SSL certificate expiry'),
  new SlashCommandBuilder().setName('queue').setDescription('BullMQ queue backlog'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a natural-language question about the database')
    .addStringOption((o) =>
      o.setName('question').setDescription('Your question in plain English').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('AI ops assistant — ask anything about the server or business'),
].map((c) => c.toJSON());

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim();
}

function httpGet(url) {
  const out = sh(`curl -s -m 10 -w '\\n%{http_code}' '${url}'`).split('\n');
  const code = out.pop();
  return { code, body: out.join('\n') };
}

function latestBackup() {
  const files = sh(`ls -t ${BACKUP_DIR}/travio-*.dump 2>/dev/null`)
    .split('\n')
    .filter(Boolean);
  if (!files.length) return null;
  const file = files[0];
  const [size, mtime] = sh(`stat -c '%s %Y' '${file}'`).split(' ');
  const ageH = Math.round(Date.now() / 1000 - Number(mtime)) / 3600;
  return { file, size: Number(size), ageH: Math.round(ageH) };
}

// ── Schema cache (for /ask text-to-SQL) ──────────────────────────────
let schemaCache = null;
let schemaCacheTime = 0;
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const JSONB_COLS = [
  ['SupplierProfile', 'businessInfo'],
  ['SupplierProfile', 'operatingInfo'],
  ['SupplierProfile', 'representativeInfo'],
  ['SupplierProfile', 'payoutInfo'],
  ['SupplierProfile', 'compliance'],
  ['Tour', 'productContent'],
  ['Tour', 'categorization'],
  ['Tour', 'schedulesAndPricing'],
  ['Tour', 'theme'],
  ['Booking', 'pickup'],
  ['User', 'notificationPreferences'],
  ['SystemConfig', 'value'],
];

async function loadSchema() {
  const now = Date.now();
  if (schemaCache && now - schemaCacheTime < SCHEMA_CACHE_TTL_MS) return schemaCache;
  try {
    // 1) Base columns
    const r = await pg.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    const tables = {};
    for (const row of r.rows) {
      if (!tables[row.table_name]) tables[row.table_name] = [];
      tables[row.table_name].push(`${row.column_name} ${row.data_type}`);
    }
    let schema = Object.entries(tables)
      .map(([t, cols]) => `${t}(${cols.join(', ')})`)
      .join('\n');

    // 2) JSONB key introspection — sample rows to discover actual keys
    for (const [table, col] of JSONB_COLS) {
      try {
        const keyR = await pg.query(
          `SELECT DISTINCT k FROM (
             SELECT jsonb_object_keys(t."${col}") AS k
             FROM "${table}" t
             WHERE "${col}" IS NOT NULL AND jsonb_typeof("${col}") = 'object'
             LIMIT 500
           ) s ORDER BY k`
        );
        if (!keyR.rows.length) continue;
        const keys = keyR.rows.map((r) => r.k).join(', ');
        schema += `\n${table}.${col}(jsonb): {${keys}}`;

        // 3) Sample values for name-like keys (so AI knows the real format)
        const nameKeys = ['legalBusinessName', 'displayName', 'businessName'];
        const present = nameKeys.filter((k) => keyR.rows.some((r) => r.k === k));
        if (present.length) {
          const cols = present.map((k) => `"${col}"->>'${k}'`).join(', ');
          const sampleR = await pg.query(
            `SELECT ${cols} FROM "${table}" WHERE "${col}" IS NOT NULL AND jsonb_typeof("${col}") = 'object' ORDER BY "createdAt" DESC LIMIT 2`
          );
          if (sampleR.rows.length) {
            const samples = sampleR.rows.map((row) =>
              present.map((k) => `${k}="${row[k] || ''}"`).join(', ')
            ).join('; ');
            schema += `\n  sample values: ${samples}`;
          }
        }
      } catch { /* skip column on error */ }
    }

    schemaCache = schema;
    schemaCacheTime = now;
    return schemaCache;
  } catch {
    return schemaCache || '';
  }
}

// ── Conversation history (Redis-backed, per-user) ────────────────────
const HISTORY_TTL_SEC = 3600; // 1 hour
const HISTORY_MAX_TURNS = 12; // 6 Q&A pairs

function historyKey(userId) { return `ai:conv:${userId}`; }

async function getHistory(userId) {
  const r = await getRedis()?.get(historyKey(userId));
  return r ? JSON.parse(r) : [];
}

async function pushTurn(userId, role, content) {
  const redis = getRedis();
  if (!redis) return;
  const key = historyKey(userId);
  const turns = await getHistory(userId);
  turns.push({ role, content });
  // Keep only the last HISTORY_MAX_TURNS
  while (turns.length > HISTORY_MAX_TURNS) turns.shift();
  await redis.set(key, JSON.stringify(turns), 'EX', HISTORY_TTL_SEC);
}

// ── Shared conversational engine ─────────────────────────────────────
// Used by both the dedicated channel and (optionally) /chat.
// Returns the text to reply with (plain string or embed).
const activeJobs = new Set(); // per-user concurrency lock

async function answerConversational(prompt, userId) {
  if (activeJobs.has(userId)) {
    return { busy: true };
  }
  activeJobs.add(userId);

  try {
    const schema = await loadSchema();
    const history = await getHistory(userId);
    const historyText = history.length
      ? `\n\nPrevious conversation:\n${history.map((t) => `${t.role}: ${t.content}`).join('\n')}`
      : '';

    // ── Step 1: Route — answer vs query ────────────────────────────
    const routeSystem = `You are TravioAfrica's ops assistant. Decide if the user's question needs a database query or can be answered conversationally.

Rules:
- If the question asks about data in the database (bookings, tours, suppliers, users, revenue, disputes, etc.) → output ONLY a JSON object: {"type":"query","sql":"SELECT ..."}
- If it's a greeting, follow-up clarification, opinion, or non-data question → output ONLY a JSON object: {"type":"answer","text":"..."}
- For query type: use SELECT or WITH only (read-only). Use ->> for JSONB text fields, ILIKE '%term%' for fuzzy matching. Check all name-like keys (e.g. legalBusinessName, displayName, businessName).
- For follow-ups referencing a previous query, you may reuse the same table/columns from prior context.
- Do NOT output anything except the JSON object.
- Schema:\n${schema}${historyText}`;

    const raw = await callMimo({ system: routeSystem, user: prompt, maxTokens: 1024, temperature: 0.1 });
    const parsed = JSON.parse(raw);
    await pushTurn(userId, 'user', prompt);

    // ── Step 2a: Conversational answer ─────────────────────────────
    if (parsed.type === 'answer') {
      await pushTurn(userId, 'assistant', parsed.text);
      return { text: parsed.text.slice(0, 2000) };
    }

    // ── Step 2b: Query path ────────────────────────────────────────
    const sql = parsed.sql.replace(/```sql\s*/gi, '').replace(/```\s*/gi, '').trim();
    const guard = validateReadOnly(sql);
    if (!guard.ok) {
      const msg = `Sorry, I can't run that query: ${guard.error}`;
      await pushTurn(userId, 'assistant', msg);
      return { text: msg };
    }
    const result = await pg.query(guard.safeSql).catch((e) => ({ error: e.message }));
    if (result.error) {
      const msg = `Query error: \`${result.error.slice(0, 500)}\``;
      await pushTurn(userId, 'assistant', msg);
      return { text: msg };
    }
    const rows = result.rows || [];

    // Step 3: Summarize
    const summary = await callMimo({
      system: 'You are a data analyst. Summarize the SQL result in plain English for a business user. Be concise (max 6 sentences).',
      user: `Question: ${prompt}\nSQL: ${guard.safeSql}\nResults:\n${JSON.stringify(rows.slice(0, 30), null, 2)}`,
      maxTokens: 1024,
      temperature: 0.2,
    });

    console.log(`[ai] user=${userId} question="${prompt}" sql="${guard.safeSql}" rows=${rows.length}`);
    await pushTurn(userId, 'assistant', summary);
    return { text: summary.slice(0, 2000) };
  } catch (e) {
    console.error('[ai] error:', e.message);
    return { text: `AI error: ${e.message.slice(0, 500)}` };
  } finally {
    activeJobs.delete(userId);
  }
}

async function isAllowed(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  return false;
}

client.once('ready', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('[bot] slash commands registered');
  } catch (e) {
    console.error('[bot] command registration failed:', e.message);
  }
});

// ── Approval handler (payouts + disputes) ──────────────────────────

async function performApproval(interaction, { type, action, id, outcome, resolution, reason }) {
  const secret = process.env.DISCORD_APPROVAL_SECRET;
  if (!secret) {
    return interaction.reply({ content: 'Bot approval secret is not configured.', ephemeral: true });
  }
  const body = { type, action, id, actorDiscordId: interaction.user.id, actorDiscordTag: interaction.user.tag };
  if (type === 'payout' && action === 'reject' && reason) body.reason = reason;
  if (type === 'dispute') {
    body.outcome = outcome;
    body.resolution = resolution;
  }
  const resp = await fetch(`${API_URL}/api/webhooks/discord/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  const done = resp.ok;
  let reply;
  if (done) {
    const label = type === 'dispute'
      ? `Refund request ${id} ${outcome === 'CUSTOMER' ? 'approved' : 'denied'}`
      : `Payout request ${id} ${action}d`;
    reply = `${label} by <@${interaction.user.id}>.` + (reason ? `\nReason: ${reason}` : '') + (resolution ? `\nResolution: ${resolution}` : '');
  } else {
    reply = `Action failed: ${data.message || resp.statusText}`;
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: reply });
  } else {
    await interaction.reply({ content: reply, ephemeral: true });
  }
  if (done) {
    await interaction.message?.edit({ components: [] }).catch(() => {});
  }
}

async function handleButton(interaction) {
  try {
    const [kind, action, id] = String(interaction.customId || '').split(':');
    if (kind !== 'pv' && kind !== 'dsp') return;

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!(await isAllowed(member))) {
      return interaction.reply({ content: 'You need the Admin role to approve.', ephemeral: true });
    }

    // Dispute buttons: both approve and deny require a resolution modal
    if (kind === 'dsp') {
      const modal = new ModalBuilder()
        .setCustomId(`dsp:${action}:${id}`)
        .setTitle(action === 'approve' ? 'Approve refund' : 'Deny refund');
      const reasonInput = new TextInputBuilder()
        .setCustomId('resolution')
        .setLabel(action === 'approve' ? 'Refund amount & resolution note' : 'Denial reason (shown to supplier)')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    // Payout reject: modal for reason
    if (action === 'reject') {
      const modal = new ModalBuilder()
        .setCustomId(`pv:reject:${id}`)
        .setTitle('Reject payout request');
      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Rejection reason (shown to the supplier)')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    await interaction.deferReply({ ephemeral: true });
    await performApproval(interaction, { type: 'payout', action, id });
  } catch (e) {
    console.error('[bot] button error:', e.message);
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
}

async function handleModal(interaction) {
  try {
    const [kind, action, id] = String(interaction.customId || '').split(':');
    if (kind !== 'pv' && kind !== 'dsp') return;

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!(await isAllowed(member))) {
      return interaction.reply({ content: 'You need the Admin role to approve.', ephemeral: true });
    }

    const resolution = interaction.fields.getTextInputValue('resolution');

    if (kind === 'dsp') {
      const outcome = action === 'approve' ? 'CUSTOMER' : 'SUPPLIER';
      await interaction.deferReply({ ephemeral: true });
      await performApproval(interaction, { type: 'dispute', action: 'resolve', id, outcome, resolution });
      return;
    }

    if (kind === 'pv' && action === 'reject') {
      await interaction.deferReply({ ephemeral: true });
      await performApproval(interaction, { type: 'payout', action: 'reject', id, reason: resolution });
      return;
    }
  } catch (e) {
    console.error('[bot] modal error:', e.message);
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
}

// ── Dedicated AI channel (messageCreate) ─────────────────────────────
if (AI_CHANNEL_ID) {
  client.on('messageCreate', async (message) => {
    // Only respond in the dedicated channel, ignore bots/self
    if (message.channel.id !== AI_CHANNEL_ID) return;
    if (message.author.bot) return;

    const member = await message.guild?.members.fetch(message.author.id).catch(() => null);
    if (!(await isAllowed(member))) return;

    const prompt = message.content.trim();
    if (!prompt) return;

    try {
      await message.channel.sendTyping();
      const reply = await answerConversational(prompt, message.author.id);
      if (reply.busy) {
        await message.reply('Still working on the previous question — one moment.');
        return;
      }
      await message.reply(reply.text);
    } catch (e) {
      console.error('[ai channel] error:', e.message);
      await message.reply(`AI error: ${e.message.slice(0, 500)}`).catch(() => {});
    }
  });
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    return handleButton(interaction);
  }
  if (interaction.isModalSubmit()) {
    return handleModal(interaction);
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!(await isAllowed(member))) {
      return interaction.reply({ content: 'You need the Admin role to use this bot.', ephemeral: true });
    }
    await interaction.deferReply();

    switch (interaction.commandName) {
      case 'health': {
        let text;
        try {
          const { code, body } = httpGet(`${API_URL}/health`);
          text =
            code === '200'
              ? `API healthy\n\`\`\`${body}\`\`\``
              : `API returned HTTP ${code}: ${body.slice(0, 500)}`;
        } catch (e) {
          text = `API unreachable: ${e.message}`;
        }
        await interaction.editReply(text);
        break;
      }

      case 'backup': {
        const b = latestBackup();
        if (!b) return interaction.editReply('No backup files found.');
        const lastLog = sh(`grep 'Backup complete' /var/log/travio-backup.log | tail -1`) || 'n/a';
        await interaction.editReply(
          `**Latest backup**\n${b.file}\nSize: ${(b.size / 1048576).toFixed(1)} MB · Age: ${b.ageH}h\nLast success: ${lastLog}`
        );
        break;
      }

      case 'uptime': {
        await interaction.editReply(`\`\`\`${sh('uptime')}\`\`\``);
        break;
      }

      case 'disk': {
        await interaction.editReply(`\`\`\`${sh('df -h / | tail -1')}\`\`\``);
        break;
      }

      case 'bookings': {
        const range = interaction.options.getString('range') || 'today';
        let sql, label;
        if (range === 'week') {
          sql = `SELECT count(*)::int, coalesce(sum("total"),0)::float FROM "Booking" WHERE "createdAt" >= now() - interval '7 days' AND "isSimulated" = false`;
          label = 'last 7 days';
        } else {
          sql = `SELECT count(*)::int, coalesce(sum("total"),0)::float FROM "Booking" WHERE "createdAt" >= date_trunc('day', now()) AND "isSimulated" = false`;
          label = 'today';
        }
        const r = await pg.query(sql).catch(() => null);
        if (!r) return interaction.editReply('Could not query bookings (DB error).');
        const count = r.rows[0].count;
        const total = r.rows[0].sum.toFixed(2);
        await interaction.editReply(`Bookings ${label}: **${count}** · Total: **${total}**`);
        break;
      }

      case 'digest': {
        const b = latestBackup();
        const backupText = b
          ? `${(b.size / 1048576).toFixed(1)} MB · ${b.ageH}h old`
          : 'no backup';
        let count = 'n/a';
        let total = 'n/a';
        const r = await pg
          .query(
            `SELECT count(*)::int, coalesce(sum("total"),0)::float FROM "Booking" WHERE "createdAt" >= date_trunc('day', now()) AND "isSimulated" = false`
          )
          .catch(() => null);
        if (r) {
          count = String(r.rows[0].count);
          total = r.rows[0].sum.toFixed(2);
        }
        const disk = sh('df -h / | tail -1 | awk \'{print $3 " used of " $2 " (" $5 ")"}\'');
        const embed = new EmbedBuilder()
          .setTitle('TravioAfrica Ops Digest')
          .setColor(0x00ff88)
          .addFields(
            { name: 'Bookings today', value: `${count} · ${total}`, inline: true },
            { name: 'Latest backup', value: backupText, inline: true },
            { name: 'Disk /', value: disk, inline: true },
            { name: 'Server', value: sh('hostname'), inline: true }
          );
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'status': {
        let healthText = 'unknown';
        try {
          const { code } = httpGet(`${API_URL}/health`);
          healthText = code === '200' ? 'UP (db + redis healthy)' : `DOWN (HTTP ${code})`;
        } catch {
          healthText = 'UNREACHABLE';
        }
        const b = latestBackup();
        const backupText = b
          ? `${(b.size / 1048576).toFixed(1)} MB · ${b.ageH}h old`
          : 'no backup';
        const disk = sh('df -h / | tail -1 | awk \'{print $3 " used of " $2 " (" $5 ")"}\'');
        const load = sh('cut -d\' \' -f1 /proc/loadavg');
        const uptime = sh('uptime -p').replace('up ', '');
        let bookings = 'n/a';
        const r = await pg
          .query(
            `SELECT count(*)::int FROM "Booking" WHERE "createdAt" >= date_trunc('day', now()) AND "isSimulated" = false`
          )
          .catch(() => null);
        if (r) bookings = String(r.rows[0].count);
        const embed = new EmbedBuilder()
          .setTitle('TravioAfrica Ops Status')
          .setColor(healthText.startsWith('UP') ? 0x00ff88 : 0xff5555)
          .addFields(
            { name: 'API', value: healthText, inline: true },
            { name: 'Bookings today', value: bookings, inline: true },
            { name: 'Load (1m)', value: load, inline: true },
            { name: 'Uptime', value: uptime, inline: true },
            { name: 'Latest backup', value: backupText, inline: false },
            { name: 'Disk /', value: disk, inline: false }
          );
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'revenue': {
        const range = interaction.options.getString('range') || 'today';
        let interval, label;
        if (range === 'month') {
          interval = "interval '30 days'";
          label = 'last 30 days';
        } else if (range === 'week') {
          interval = "interval '7 days'";
          label = 'last 7 days';
        } else {
          interval = "interval '1 day'";
          label = 'today';
        }
        const r = await pg
          .query(
            `SELECT count(*)::int as bookings,
                    coalesce(sum("grossAmount"),0)::float as revenue,
                    coalesce(sum("platformCommission"),0)::float as commission,
                    coalesce(sum("supplierPayout"),0)::float as supplier_total
             FROM "Booking"
             WHERE "createdAt" >= date_trunc('day', now()) - ${interval}
               AND "status" = 'CONFIRMED' AND "isSimulated" = false`
          )
          .catch(() => null);
        if (!r) return interaction.editReply('Could not query revenue (DB error).');
        const { bookings, revenue, commission, supplier_total } = r.rows[0];
        const embed = new EmbedBuilder()
          .setTitle(`Revenue — ${label}`)
          .setColor(0x00bcd4)
          .addFields(
            { name: 'Bookings', value: String(bookings), inline: true },
            { name: 'Revenue', value: `$${revenue.toFixed(2)}`, inline: true },
            { name: 'Commission', value: `$${commission.toFixed(2)}`, inline: true },
            { name: 'Supplier payouts', value: `$${supplier_total.toFixed(2)}`, inline: true }
          );
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'payouts': {
        const r = await pg
          .query(
            `SELECT count(*)::int as pending,
                    coalesce(sum(amount),0)::float as total,
                    currency
             FROM "PayoutRequest"
             WHERE status IN ('PENDING','UNDER_REVIEW')
             GROUP BY currency`
          )
          .catch(() => null);
        if (!r || r.rows.length === 0) {
          return interaction.editReply('No pending payout requests.');
        }
        const lines = r.rows.map((row) => `${row.currency} **${row.total.toFixed(2)}** (${row.pending} requests)`);
        await interaction.editReply(`**Pending payouts**\n${lines.join('\n')}`);
        break;
      }

      case 'disputes': {
        const r = await pg
          .query(
            `SELECT d."disputeNumber", d.reason, d.status,
                    b."bookingNumber", b."grossAmount", b.currency,
                    t.title as "tourTitle"
             FROM "Dispute" d
             JOIN "Booking" b ON b.id = d."bookingId"
             JOIN "Tour" t ON t.id = b."tourId"
             WHERE d.status IN ('OPEN','UNDER_REVIEW')
             ORDER BY d."createdAt" DESC
             LIMIT 10`
          )
          .catch(() => null);
        if (!r || r.rows.length === 0) {
          return interaction.editReply('No open refund requests.');
        }
        const fields = r.rows.map((d) => ({
          name: d.disputeNumber,
          value: `${d.tourTitle} · ${d.currency} ${parseFloat(d.grossAmount).toFixed(2)} · ${d.reason.replace(/_/g, ' ')}`,
          inline: false,
        }));
        const count = await pg.query(`SELECT count(*)::int FROM "Dispute" WHERE status IN ('OPEN','UNDER_REVIEW')`).catch(() => null);
        const total = count?.rows?.[0]?.count || r.rows.length;
        const embed = new EmbedBuilder()
          .setTitle(`Open refund requests (${total})`)
          .setColor(0xffaa00)
          .addFields(fields);
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'signups': {
        const range = interaction.options.getString('range') || 'today';
        let interval, label;
        if (range === 'week') {
          interval = "interval '7 days'";
          label = 'last 7 days';
        } else {
          interval = "interval '1 day'";
          label = 'today';
        }
        const [users, suppliers] = await Promise.all([
          pg.query(
            `SELECT count(*)::int FROM "User" WHERE "createdAt" >= date_trunc('day', now()) - ${interval}`
          ).catch(() => null),
          pg.query(
            `SELECT count(*)::int FROM "SupplierProfile" WHERE "createdAt" >= date_trunc('day', now()) - ${interval}`
          ).catch(() => null),
        ]);
        const userCount = users?.rows?.[0]?.count ?? 'n/a';
        const supplierCount = suppliers?.rows?.[0]?.count ?? 'n/a';
        await interaction.editReply(`Signups ${label}: **${userCount}** users · **${supplierCount}** suppliers`);
        break;
      }

      case 'cert': {
        try {
          const out = sh(`echo | openssl s_client -servername apiv1.travioafrica.com -connect apiv1.travioafrica.com:443 2>/dev/null | openssl x509 -noout -dates 2>/dev/null`);
          const notAfter = out.match(/notAfter=(.+)/)?.[1];
          if (!notAfter) throw new Error('Could not parse cert dates');
          const expiry = new Date(notAfter);
          const daysLeft = Math.round((expiry.getTime() - Date.now()) / 86400000);
          const color = daysLeft > 30 ? 0x00ff88 : daysLeft > 7 ? 0xffaa00 : 0xff4444;
          const embed = new EmbedBuilder()
            .setTitle('SSL Certificate')
            .setColor(color)
            .addFields(
              { name: 'Domain', value: 'apiv1.travioafrica.com', inline: true },
              { name: 'Expires', value: expiry.toLocaleDateString(), inline: true },
              { name: 'Days left', value: String(daysLeft), inline: true }
            );
          await interaction.editReply({ embeds: [embed] });
        } catch (e) {
          await interaction.editReply(`Cert check failed: ${e.message}`);
        }
        break;
      }

      case 'queue': {
        const r = getRedis();
        if (!r) {
          await interaction.editReply('Redis not available — /queue requires REDIS_URL in bot .env');
          break;
        }
        const queues = [
          'communications-emails',
          'communications-notifications',
          'webhook-retry',
          'platform-stripe',
          'analytics-events',
          'analytics-aggregations',
          'system-cleanup',
          'content-sync',
          'homepage-precompute',
          'ai-scoring',
        ];
        const results = [];
        for (const q of queues) {
          try {
            const counts = await r.multi()
              .llen(`bull:${q}:waiting`)
              .llen(`bull:${q}:active`)
              .llen(`bull:${q}:delayed`)
              .exec();
            const waiting = counts[0][1] || 0;
            const active = counts[1][1] || 0;
            const delayed = counts[2][1] || 0;
            const total = waiting + active + delayed;
            if (total > 0) {
              results.push(`${q}: **${total}** (waiting: ${waiting}, active: ${active}, delayed: ${delayed})`);
            }
          } catch {
            // queue doesn't exist or connection issue — skip
          }
        }
        const embed = new EmbedBuilder()
          .setTitle('BullMQ Queue Backlog')
          .setColor(results.length > 0 ? 0xffaa00 : 0x00ff88)
          .setDescription(results.length > 0 ? results.join('\n') : 'All queues clear');
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'ask': {
        if (!process.env.MIMO_API_KEY) {
          await interaction.editReply('MIMO_API_KEY is not configured on the bot.');
          break;
        }
        const question = interaction.options.getString('question');
        try {
          const schema = await loadSchema();
          if (!schema) {
            await interaction.editReply('Failed to load database schema. Check pg connection.');
            break;
          }
          const system = `You are a PostgreSQL read-only query generator for TravioAfrica. Convert the user's natural language question into a single safe SQL SELECT query. Rules:\n- Output ONLY the SQL query, no explanation, no markdown fences.\n- JSONB columns (marked "jsonb"): use ->> to extract text fields, NOT @> containment.\n- For entity lookups (suppliers, tours, users) use ILIKE '%term%' for fuzzy/partial matches. Check ALL name-like keys (e.g. legalBusinessName, displayName, businessName for suppliers).\n- Use JOINs, CTEs, GROUP BY, aggregates as needed.\n- Only use exact @> when the exact JSON value is known.\n\nSchema:\n${schema}`;
          console.log(`[ask] question="${question}" schema_len=${schema.length}`);
          const sql = await callMimo({ system, user: question, maxTokens: 512, temperature: 0.1 });
          const cleanSql = sql.replace(/```sql\s*/gi, '').replace(/```\s*/gi, '').trim();
          const guard = validateReadOnly(cleanSql);
          if (!guard.ok) {
            await interaction.editReply(`Sorry, I can't run that query: ${guard.error}`);
            break;
          }
          const result = await pg.query(guard.safeSql).catch((e) => ({ error: e.message }));
          if (result.error) {
            await interaction.editReply(`Query error: \`${result.error.slice(0, 500)}\``);
            break;
          }
          const rows = result.rows || [];
          const summary = await callMimo({
            system: 'You are a data analyst. Summarize the SQL result in plain English for a business user. Be concise (max 6 sentences).',
            user: `Question: ${question}\nSQL: ${guard.safeSql}\nResults:\n${JSON.stringify(rows.slice(0, 30), null, 2)}`,
            maxTokens: 1024,
            temperature: 0.2,
          });
          const embed = new EmbedBuilder()
            .setTitle('Query Result')
            .setColor(0x00bcd4)
            .setDescription(summary.slice(0, 4000));
          await interaction.editReply({ embeds: [embed] });
          console.log(`[ask] user=${interaction.user.id} question="${question}" sql="${guard.safeSql}" rows=${rows.length}`);
        } catch (e) {
          console.error('[ask] error:', e.message);
          await interaction.editReply(`AI error: ${e.message.slice(0, 500)}`);
        }
        break;
      }

      case 'chat': {
        if (!process.env.MIMO_API_KEY) {
          await interaction.editReply('MIMO_API_KEY is not configured on the bot.');
          break;
        }
        const prompt = interaction.options.getString('question');
        try {
          const reply = await answerConversational(prompt, interaction.user.id);
          if (reply.busy) {
            await interaction.editReply('Still working on the previous question — one moment.');
            break;
          }
          await interaction.editReply(reply.text);
        } catch (e) {
          console.error('[chat] error:', e.message);
          await interaction.editReply(`AI error: ${e.message.slice(0, 500)}`);
        }
        break;
      }
    }
  } catch (e) {
    console.error('[bot] error handling interaction:', e.message);
    await interaction.editReply({ content: `Error: ${e.message}` }).catch(() => {});
  }
});

client.login(TOKEN).catch((e) => {
  console.error('[bot] login failed:', e.message);
  process.exit(1);
});
