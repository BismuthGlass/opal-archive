const DEFAULT_SERVER = "http://127.0.0.1:7878";
const input = document.getElementById("server");
const said = document.getElementById("said");

const say = (text, good) => {
  said.textContent = text;
  said.className = good ? "good" : "bad";
};

chrome.storage.sync.get({ server: DEFAULT_SERVER }).then(({ server }) => {
  input.value = server === DEFAULT_SERVER ? "" : server;
});

document.getElementById("save").addEventListener("click", async () => {
  const server = (input.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  let origin;
  try {
    origin = new URL(server).origin;
  } catch {
    return say("That is not an address.", false);
  }
  // The extension may always ask this computer; anywhere else it has to
  // be allowed to, which the browser asks about once.
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (!local && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    return say("Not allowed to reach that address.", false);
  }
  await chrome.storage.sync.set({ server });
  const answer = await chrome.runtime.sendMessage({ type: "ping" });
  if (answer?.error) return say(answer.error, false);
  const sites = (Array.isArray(answer) ? answer : []).map((site) => site.title).join(", ");
  say(sites ? `Connected. It downloads from: ${sites}.` : "Connected.", true);
});
