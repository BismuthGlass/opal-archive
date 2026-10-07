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
  showLogins();
});

// Logins: each downloader that uses one, whether OpalArchive has it, and
// the buttons that send this browser's or have it forgotten.
const list = document.getElementById("logins");

async function showLogins(problem) {
  const logins = await chrome.runtime.sendMessage({ type: "logins" });
  if (logins?.error) {
    const row = document.createElement("li");
    row.textContent = logins.error;
    return list.replaceChildren(row);
  }
  list.replaceChildren(
    ...logins.map((downloader) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = downloader.title;
      const status = document.createElement("span");
      status.className = downloader.login_saved ? "status saved" : "status";
      status.textContent = downloader.login_saved
        ? `Saved ${new Date(downloader.login_saved * 1000).toLocaleString()}`
        : "None saved";

      /** Does it, then shows the list again, with what went wrong if anything. */
      const act = (button, message) => async () => {
        button.disabled = true;
        const answer = await chrome.runtime.sendMessage(message);
        showLogins(answer?.error ? { name: downloader.name, text: answer.error } : undefined);
      };
      const send = document.createElement("button");
      send.textContent = downloader.login_saved ? "Send it again" : "Send my login";
      send.title = `Gives OpalArchive this browser's ${downloader.title} cookies`;
      send.addEventListener(
        "click",
        act(send, { type: "sendLogin", name: downloader.name, sites: downloader.sites }),
      );
      row.append(name, status, send);
      if (downloader.login_saved) {
        const forget = document.createElement("button");
        forget.textContent = "Forget";
        forget.title = "Has OpalArchive delete the login it keeps";
        forget.addEventListener("click", act(forget, { type: "forgetLogin", name: downloader.name }));
        row.append(forget);
      }
      if (problem?.name === downloader.name) {
        const said = document.createElement("p");
        said.className = "problem";
        said.setAttribute("role", "alert");
        said.textContent = problem.text;
        row.append(said);
      }
      return row;
    }),
  );
  if (logins.length === 0) {
    const row = document.createElement("li");
    row.textContent = "No downloader uses a login.";
    list.append(row);
  }
}

showLogins();

