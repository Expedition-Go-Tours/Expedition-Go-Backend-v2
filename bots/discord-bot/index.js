const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { execSync } = require('child_process');
const { Client: Pg } = require('pg');
require('dotenv').config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID;
const API_URL = process.env.API_URL || 'http://127.0.0.1:5000';
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/travio';

const pg = new Pg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
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

async function handleButton(interaction) {
  try {
    const [kind, action, id] = String(interaction.customId || '').split(':');
    if (kind !== 'pv') return;
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!(await isAllowed(member))) {
      return interaction.reply({ content: 'You need the Admin role to approve.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const secret = process.env.DISCORD_APPROVAL_SECRET;
    if (!secret) {
      return interaction.editReply({ content: 'Bot approval secret is not configured.' });
    }
    const body = { type: 'payout', action, id };
    if (action === 'reject') body.reason = 'Rejected via Discord';
    const resp = await fetch(`${API_URL}/api/webhooks/discord/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      await interaction.editReply({ content: `Payout request ${id} ${action}d by <@${interaction.user.id}>.` });
      await interaction.message.edit({ components: [] }).catch(() => {});
    } else {
      await interaction.editReply({ content: `Action failed: ${data.message || resp.statusText}` });
    }
  } catch (e) {
    console.error('[bot] button error:', e.message);
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    return handleButton(interaction);
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
