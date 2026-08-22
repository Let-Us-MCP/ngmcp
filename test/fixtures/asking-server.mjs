/** A server that asks as well as answers.
 *
 * Prompts, a tool that elicits, a tool that samples, and something to stir so
 * a subscription has a change to report.
 */
import { App } from "../../dist/index.js";

const app = new App({ name: "asking", version: "1.0.0" });

app.resource("res://rows", { name: "Rows", mimeType: "text/plain", text: "a,b" });
app.resource("res://other", { name: "Other", mimeType: "text/plain", text: "x" });

app.prompt("triage", {
  description: "Work through an incident in order.",
  arguments: [
    { name: "service", description: "Which service is failing.", required: true },
    { name: "since", description: "How far back to look.", required: false },
  ],
}, (args) => [
  {
    role: "user",
    content: {
      type: "text",
      text: `Triage ${args.service ?? "the service"}, looking back ${args.since ?? "an hour"}.`,
    },
  },
  { role: "assistant", content: { type: "text", text: "Starting with the error rate." } },
]);

app.prompt("postmortem", {
  description: "Write up what happened.",
}, () => [{ role: "user", content: { type: "text", text: "Write the postmortem." } }]);

app.tool("restart", {
  description: "Restart a deployment, after asking why.",
  annotations: { destructiveHint: true },
}, async (input, ctx) => {
  // Nothing is changed before the answer is in hand, because this handler runs
  // again from the top when the client retries with it.
  const answer = await ctx.elicit("why", {
    message: "Why is this being restarted?",
    requestedSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line." } },
      required: ["reason"],
    },
  });
  if (answer.action !== "accept") {
    return { action: answer.action, restarted: false, id: input.id ?? null };
  }
  return { action: "accept", restarted: true, reason: String(answer.content.reason ?? "") };
});

app.tool("summarise", {
  description: "Summarise the incident, using the client's model.",
  annotations: { readOnlyHint: true },
}, async (_input, ctx) => {
  const answer = await ctx.sample("summary", {
    messages: [{ role: "user", content: { type: "text", text: "Summarise the incident." } }],
    maxTokens: 200,
  });
  if (!answer.ok) return { ok: false, reason: answer.reason, detail: answer.detail };
  return { ok: true, model: answer.model, text: answer.content.text ?? "" };
});

app.tool("stir", {
  description: "Change a resource and the tool list, so subscribers hear something.",
}, async () => {
  const resources = app.resourceUpdated("res://rows");
  const other = app.resourceUpdated("res://other");
  const tools = app.listChanged("tools");
  return { resources, other, tools };
});

app.tool("both_at_once", {
  description: "Asks for two things in one round trip rather than two.",
  annotations: { readOnlyHint: true },
}, async (_input, ctx) => {
  const answers = ctx.requireInputs({
    who: {
      method: "elicitation/create",
      params: {
        mode: "form", message: "Who is asking?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } },
          required: ["name"] },
      },
    },
    summary: {
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "text", text: "One sentence." } }],
        maxTokens: 50,
      },
    },
  });
  return {
    who: String(answers.who?.content?.name ?? ""),
    summary: String(answers.summary?.content?.text ?? ""),
  };
});

app.serve();
