const trace = document.querySelector("#trace");
const answer = document.querySelector("#answer");
const status = document.querySelector("#status");
const message = document.querySelector("#message");
const coverage = document.querySelector("#coverage");
const verdicts = document.querySelector("#verdicts");
const conversationId = localStorage.getItem("minimiConversation") ?? "demo-conversation";
localStorage.setItem("minimiConversation", conversationId);

function showAnswer(text) {
  answer.replaceChildren();
  const citation = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(citation)) {
    answer.append(document.createTextNode(text.slice(offset, match.index)));
    const link = document.createElement("a");
    link.href = match[2];
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = match[1].replaceAll("\\]", "]");
    answer.append(link);
    offset = match.index + match[0].length;
  }
  answer.append(document.createTextNode(text.slice(offset)));
}

function showResults(event) {
  const { inScope = 0, fullyChecked = 0, unverified = 0, conflicting = 0 } = event.coverage ?? {};
  coverage.textContent = `${fullyChecked} of ${inScope} checked · ${unverified} unverified · ${conflicting} conflicting`;
  verdicts.replaceChildren();
  for (const item of event.verdicts ?? []) {
    const row = document.createElement("tr");
    for (const value of [item.entity, item.baseline ?? "—", item.current ?? "—", item.status.replaceAll("_", " "), item.confidence]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const citations = document.createElement("td");
    for (const citation of item.citations) {
      const link = document.createElement("a");
      link.href = citation.url;
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      link.textContent = citation.title;
      citations.append(link, document.createTextNode(" "));
    }
    row.append(citations);
    verdicts.append(row);
  }
}

async function ask(prompt) {
  message.value = prompt;
  answer.textContent = "Searching and checking evidence…";
  status.textContent = "working";
  trace.replaceChildren();
  const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, clientMessageId: crypto.randomUUID(), message: prompt }) });
  if (!response.ok || !response.body) throw new Error(`Request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const eventName = frame.match(/^event: (.+)$/m)?.[1];
      const line = frame.split("\n").find((part) => part.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "answer_final") { showAnswer(event.answer); showResults(event); }
      else if (event.type === "answer_delta") showAnswer(event.text);
      else if (event.type === "clarify") showAnswer(event.question);
      else if (event.type === "run_failed") showAnswer(event.recoverableMessage);
      if (event.type === "heartbeat") continue;
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = event.type === "tool_started" ? `Search: ${event.query}`
        : event.type === "anchor_resolved" ? `Time: ${event.interval?.localStart ?? "resolved"}`
          : event.type === "verification_progress" ? `Checked: ${event.checked}/${event.total}`
            : event.type === "run_state" ? `State: ${event.state}` : eventName ?? event.type;
      trace.append(pill);
    }
  }
  status.textContent = "ready";
}

document.querySelector("#chat").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await ask(message.value); } catch (error) { status.textContent = "error"; showAnswer(error.message); }
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", async () => {
  try { await ask(button.dataset.prompt); } catch (error) { status.textContent = "error"; showAnswer(error.message); }
}));
