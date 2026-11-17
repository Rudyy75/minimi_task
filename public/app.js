const trace = document.querySelector("#trace");
const status = document.querySelector("#status");
document.querySelector("#connect").addEventListener("click", async () => {
  status.textContent = "connecting";
  const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  status.textContent = "connected";
  trace.replaceChildren();
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
      const line = frame.split("\n").find((part) => part.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = event.type === "heartbeat" ? `heartbeat ${event.at}` : event.type;
      trace.append(pill);
    }
  }
});
