const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Client, Events, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const { draftIssue } = require("./llm");
const { createIssue } = require("./github");
const config = require("./config.json");

// Pflicht-Variablen sofort prüfen: ohne OWNER_ID könnte sonst niemand klicken, ohne dass man es merkt
const REQUIRED_ENV = ["DISCORD_TOKEN", "OWNER_ID"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Fehlende Umgebungsvariablen: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const OWNER_ID = process.env.OWNER_ID;
const DISCORD_MAX_LENGTH = 2000; // Discord erlaubt maximal 2000 Zeichen pro Nachricht
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // Entwürfe verfallen nach 24 Stunden
const HEARTBEAT_INTERVAL_MS = 30_000;
// Pfad muss zum Docker-Healthcheck passen, daher per Umgebungsvariable überschreibbar
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? path.join(os.tmpdir(), "heartbeat");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // Server und Channels
    GatewayIntentBits.GuildMessages, // Nachrichten-Events
    GatewayIntentBits.MessageContent, // Nachrichtentext lesen
  ],
});

// Nachrichten-ID der Bot-Antwort -> { issue, repo, createdAt }
const drafts = new Map();

const buttons = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("approve").setLabel("Anlegen").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("reject").setLabel("Verwerfen").setStyle(ButtonStyle.Danger),
);

// Kürzt auf das Discord-Limit, mit sichtbarem Hinweis statt stillem Abschneiden
const truncate = (text, suffix = "\n\n… *(gekürzt, der volle Text geht an GitHub)*") => {
  if (text.length <= DISCORD_MAX_LENGTH) return text;
  const fenceClose = "\n```";
  let cut = text.slice(0, DISCORD_MAX_LENGTH - suffix.length - fenceClose.length);
  // Ungerade Anzahl an ``` heißt: mitten im Codeblock geschnitten -> Block schließen
  if ((cut.match(/```/g) ?? []).length % 2 === 1) cut += fenceClose;
  return cut + suffix;
};

// Entfernt die Bot-Erwähnung in beiden Schreibweisen: <@id> und <@!id>
const stripMention = (content, userId) => content.replaceAll(new RegExp(`<@!?${userId}>`, "g"), "").trim();

const writeHeartbeat = async () => {
  if (!client.isReady()) return; // nur schreiben, wenn der Bot mit Discord verbunden ist
  try {
    await fs.writeFile(HEARTBEAT_FILE, String(Date.now()));
  } catch (err) {
    console.error("Heartbeat konnte nicht geschrieben werden:", err);
  }
};

const removeExpiredDrafts = () => {
  const now = Date.now();
  for (const [id, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(id);
  }
};

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Eingeloggt als ${readyClient.user.tag}`);
  writeHeartbeat(); // sofort schreiben, damit der Healthcheck nicht erst nach 30 s grün wird
});

client.on(Events.Error, (err) => {
  console.error("Discord-Client-Fehler:", err);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return; // Bots werden ignoriert

  const repo = config.channels[msg.channelId]; // Channel-ID -> "owner/name" aus config.json
  if (!repo) return;

  // Nur echte, direkte Erwähnungen: kein @everyone/@here, keine Rollen, keine Reply-Pings
  const mentioned = msg.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
  if (!mentioned) return;

  try {
    // Schon hier prüfen, damit nicht jeder im Channel LLM-Kosten auslösen kann
    if (msg.author.id !== OWNER_ID) {
      await msg.reply({ content: "Du darfst keine Issues anlegen.", allowedMentions: { parse: [] } });
      return;
    }

    const cleanText = stripMention(msg.content, client.user.id);
    if (!cleanText) {
      await msg.reply({ content: "Bitte beschreibe das Issue in derselben Nachricht wie die Erwähnung.", allowedMentions: { parse: [] } });
      return;
    }

    await msg.channel.sendTyping(); // zeigt, dass der Bot arbeitet
    const issue = await draftIssue(cleanText);

    const text = `Repo: \`${repo}\`\n**${issue.title}**\n\n${issue.body}\n\nLabels: ${issue.labels.join(", ")}`;
    const reply = await msg.reply({
      content: truncate(text),
      components: [buttons],
      allowedMentions: { parse: [] }, // @everyone oder <@id> im Issue-Text sollen niemanden pingen
    });
    drafts.set(reply.id, { issue, repo, createdAt: Date.now() });
  } catch (err) {
    console.error(err);
    try {
      await msg.reply({ content: "Das hat nicht geklappt, siehe Logs.", allowedMentions: { parse: [] } });
    } catch (replyErr) {
      // Auch die Antwort kann fehlschlagen (fehlende Rechte, gelöschte Nachricht): nur loggen
      console.error("Fehlermeldung konnte nicht gesendet werden:", replyErr);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "approve" && interaction.customId !== "reject") return;

  try {
    if (interaction.user.id !== OWNER_ID) {
      await interaction.reply({
        content: "Du darfst das nicht.",
        flags: MessageFlags.Ephemeral, // nur für den Nutzer sichtbar, der geklickt hat
      });
      return;
    }

    const id = interaction.message.id;
    const draft = drafts.get(id);

    if (!draft) {
      await interaction.reply({
        content: "Der Entwurf ist nicht mehr vorhanden (abgelaufen oder Bot neu gestartet).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Draft sofort "einlösen", noch VOR jedem await: ein zweiter (Doppel-)Klick findet dann nichts mehr
    drafts.delete(id);

    // Klick sofort quittieren: Discord verlangt eine Antwort innerhalb von 3 Sekunden
    try {
      await interaction.deferUpdate();
    } catch (err) {
      drafts.set(id, draft); // es ist noch nichts passiert -> Entwurf zurückgeben
      console.error("Klick konnte nicht quittiert werden:", err);
      return;
    }

    if (interaction.customId === "reject") {
      await interaction.editReply({
        content: truncate(`**VERWORFEN**\n\n${interaction.message.content}`, "\n\n… *(gekürzt)*"),
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Nur ein Fehler von createIssue selbst gibt den Entwurf zurück.
    // Schlägt danach die Discord-Antwort fehl, existiert das Issue bereits -> kein zweiter Versuch.
    let created;
    try {
      created = await createIssue(draft.repo, draft.issue);
    } catch (err) {
      console.error(err);
      drafts.set(id, draft);
      await interaction.followUp({
        content: "GitHub-Fehler, siehe Logs. Der Entwurf bleibt erhalten.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.editReply({
        content: `**ANGELEGT:** ${created.html_url}`,
        components: [],
      });
    } catch (err) {
      console.error(`Issue wurde angelegt (${created.html_url}), aber die Discord-Antwort schlug fehl:`, err);
    }
  } catch (err) {
    // Fängt fehlgeschlagene Discord-Antworten ab, damit der Prozess nicht abstürzt
    console.error("Fehler im Button-Handler:", err);
  }
});

// Heartbeat für den Docker-Healthcheck, dabei auch abgelaufene Entwürfe aufräumen
setInterval(() => {
  removeExpiredDrafts();
  writeHeartbeat();
}, HEARTBEAT_INTERVAL_MS);

// Sicherheitsnetz: eine vergessene Rejection soll den Bot nicht beenden
process.on("unhandledRejection", (err) => {
  console.error("Unbehandelte Promise-Rejection:", err);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("Login bei Discord fehlgeschlagen:", err);
  process.exit(1);
});
