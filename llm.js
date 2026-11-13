const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic(); // reads the API_KEY from the .env file

// single source of truth: used in the prompt AND to filter the model's answer
const ALLOWED_LABELS = ["bug", "enhancement", "documentation", "question", "styling"];

const SYSTEM = `
Du wandelst Nachrichten in Github-Issues um.
Antworte ausschließlich mit gültigen JSON, ohne Texte herum, im Format:
{"title":"...", "body": "...", "labels":[".."]}
Regeln:
- title: max. 70 Zeichen, sachlich
- body: Markdown mit Abschnitt "Beschreibung" und, falls sinnvoll, "Akzeptanzkriterien" als Checkliste
- labels: nur aus ${JSON.stringify(ALLOWED_LABELS)}, 1 bis 2 Stück
- Erfinde keine Details, die nicht in der Nachricht stehen.
- Sprache: wie die Nachricht.
- body -> maximal 1600 zeichen
- Wenn erwähnt wird das es codesnipets vorhanden sein können kannst du welche einfügen!
`;

async function draftIssue(txt) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: txt }],
  });
  if (response.stop_reason === "max_tokens") throw new Error("max tokens");

  // clean the response to a clean json
  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock.text.replace(/^```(?:json)?\s*|\s*```$/g, "");
  const issue = JSON.parse(raw);

  // never trust the model: keep only known labels (GitHub would create unknown ones)
  const labels = Array.isArray(issue.labels) ? issue.labels.filter((l) => ALLOWED_LABELS.includes(l)) : [];
  return { ...issue, labels };
}

module.exports = { draftIssue };
