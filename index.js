const { Client, Events, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const { draftIssue } = require("./llm");
const { createIssue } = require("./github");
const CONFIG = require("./config.json");

const CLIENT = new Client({
  intents: [
    GatewayIntentBits.Guilds, // Server und channel
    GatewayIntentBits.GuildMessages, // get messages and events
    GatewayIntentBits.MessageContent, // read messages and texts
  ],
});

const DRAFTS = new Map();

const BUTTONS = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("approve").setLabel("Anlegen").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("reject").setLabel("Verwerfen").setStyle(ButtonStyle.Danger));

CLIENT.once(Events.ClientReady, (client) => {
  console.log(`Logged in as ${client.user.tag}`);
});

CLIENT.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return; // Bots were ignored
  if (!msg.mentions.has(CLIENT.user)) return; // check if the bot is mention // TODO change to get better security
  const cleanText = cleanContent(msg.content, CLIENT.user);

  const repo = CONFIG.channels[msg.channelId]; // channel id -> "owner/name" from config.json
  if (!repo) return;

  try {
    await msg.channel.sendTyping(); // shows that the bot is typing
    const issue = await draftIssue(cleanText); // create the issue with the input from the message before

    const text = `Repo: \`${repo}\`\n**${issue.title}**\n\n${issue.body}\n\nLabels: ${issue.labels.join(", ")}`;
    const reply = await msg.reply({
      content: text.slice(0, 2000), // discord only allows 2000 chars
      components: [BUTTONS], // adds the btns for approve or reject
    });
    DRAFTS.set(reply.id, { issue, repo });
  } catch (err) {
    console.error(err);
    try {
      await msg.reply("Check the logs!");
    } catch (replyErr) {
      // Reply can fail too (missing permissions, deleted message) - log only, don't crash
      console.error("Could not send error reply:", replyErr);
    }
  }
});

CLIENT.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.user.id !== process.env.OWNER_ID) {
    return interaction.reply({
      content: "U are not allow!",
      flags: MessageFlags.Ephemeral, // only for the active user how has clicked
    });
  }

  const id = interaction.message.id;
  const draft = DRAFTS.get(id);

  if (!draft) {
    return interaction.reply({
      content: "Der vorherige Entwurf ist nicht mehr vorhanden (Bot neu gestartet?)",
      flags: MessageFlags.Ephemeral, // only for the active user
    });
  }

  // Draft sofort "einlösen", noch VOR jedem await: ein zweiter (Doppel-)Klick findet dann nichts mehr
  DRAFTS.delete(id);

  // klick sofort quittieren: Discord verlangt eine Antowrt innerhalb von 3 sekunden.
  await interaction.deferUpdate();

  if (interaction.customId === "reject") {
    return interaction.editReply({
      content: `**VERWORFEN**\n\n${interaction.message.content}`.slice(0, 2000),
      components: [],
    });
  }

  try {
    const created = await createIssue(draft.repo, draft.issue);
    await interaction.editReply({
      content: `**ANGELEGT:** ${created.html_url}`,
      components: [],
    });
  } catch (error) {
    console.error(error);
    DRAFTS.set(id, draft); // GitHub failed -> give the draft back so you can click again
    await interaction.followUp({
      content: "GitHub-Fehler, siehe Terminal. Der Entwurf bleibt erhalten.",
      flags: MessageFlags.Ephemeral,
    });
  }
});

function cleanContent(content, id) {
  return content.replaceAll(id, "").trim();
}

CLIENT.login(process.env.DISCORD_TOKEN);
