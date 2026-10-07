// The part of the extension that talks to OpalArchive. Pages cannot reach
// a server on this computer themselves, so the buttons put in them ask
// here, and this asks the server.

const DEFAULT_SERVER = "http://127.0.0.1:7878";

/** Where OpalArchive is, as set in the options. */
async function server() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return String(server || DEFAULT_SERVER).replace(/\/+$/, "");
}

/** Asks the server something, and answers with what it said or why not. */
async function ask(method, path, body) {
  let response;
  try {
    response = await fetch((await server()) + "/api" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { error: "OpalArchive is not answering. Is it running?" };
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok) return { error: answer?.error || `OpalArchive said ${response.status}` };
  return answer ?? {};
}

/**
 * Puts an address in OpalArchive's queue, with any tags to give what it
 * downloads. Answers with the request made.
 */
const send = (url, tags = []) => ask("POST", "/inbox", { url, tags });
/** What has become of a request. */
const status = (id) => ask("GET", `/inbox/queue/${id}`);

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const answer =
    message?.type === "send"
      ? send(message.url, message.tags)
      : message?.type === "status"
        ? status(message.id)
        : message?.type === "ping"
          ? ask("GET", "/inbox/sites")
          : null;
  if (!answer) return false;
  answer.then(respond);
  // The answer comes later.
  return true;
});

// The right-click menu, and the extension's own button, send without a
// button in the page: the link, the picture or video, or the page itself.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send",
    title: "Send to OpalArchive",
    contexts: ["page", "link", "image", "video"],
  });
});

/** Says on the extension's button how the last thing sent this way went. */
async function report(tab, result) {
  const failed = Boolean(result.error);
  await chrome.action.setBadgeBackgroundColor({ color: failed ? "#c92a2a" : "#2f9e44" });
  await chrome.action.setBadgeText({ tabId: tab?.id, text: failed ? "!" : "✓" });
  await chrome.action.setTitle({
    tabId: tab?.id,
    title: failed ? `OpalArchive: ${result.error}` : "Sent to OpalArchive",
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // A link is what was pointed at; failing that the page it is on, which
  // says more than the address of a picture in it.
  const url = info.linkUrl || info.pageUrl || info.srcUrl;
  if (url) report(tab, await send(url));
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url) report(tab, await send(tab.url));
});
