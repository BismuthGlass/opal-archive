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
/** The tags of a type that match what has been typed, as OpalArchive suggests them. */
const suggest = (field, q) => ask("GET", `/tags?${new URLSearchParams({ field, q })}`);
/** OpalArchive's settings: the colours given to the tag types are among them. */
const settings = () => ask("GET", "/settings");

// Logins: the cookies this browser has for a downloader's site, sent to
// OpalArchive so that it can download what the site shows to you alone.
// The server may be where there is no browser to read them from itself.

/** Whether a host is of a site as a downloader names it: see its manifest. */
function ofSite(host, site) {
  const name = site.toLowerCase();
  if (name.endsWith(".*")) return host.split(".").includes(name.slice(0, -2));
  return host === name || host.endsWith(`.${name}`);
}

/** The downloaders that use a login, each with when its login was saved. */
async function logins() {
  const all = await ask("GET", "/downloaders");
  if (all.error) return all;
  return (Array.isArray(all) ? all : []).filter((downloader) => downloader.cookies);
}

/** This browser's cookies for those sites, as a cookie file in the Netscape format. */
async function cookieFile(sites) {
  // Only the cookies of sites the extension is let onto are handed over.
  const cookies = (await chrome.cookies.getAll({})).filter((cookie) =>
    sites.some((site) => ofSite(cookie.domain.replace(/^\./, "").toLowerCase(), site)),
  );
  const lines = cookies.map((cookie) =>
    [
      (cookie.httpOnly ? "#HttpOnly_" : "") + cookie.domain,
      cookie.domain.startsWith(".") ? "TRUE" : "FALSE",
      cookie.path,
      cookie.secure ? "TRUE" : "FALSE",
      // A cookie that lasts only as long as the browser is open has no date.
      Math.round(cookie.expirationDate ?? 0),
      cookie.name,
      cookie.value,
    ].join("\t"),
  );
  return { count: cookies.length, text: ["# Netscape HTTP Cookie File", ...lines, ""].join("\n") };
}

/** Sends this browser's login for a downloader's sites to OpalArchive. */
async function sendLogin(name, sites) {
  const { count, text } = await cookieFile(sites ?? []);
  if (count === 0) return { error: "This browser has no cookies for that site: log in to it first." };
  return ask("POST", `/downloaders/${name}/cookies/file`, { cookies: text });
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const answer =
    message?.type === "send"
      ? send(message.url, message.tags)
      : message?.type === "status"
        ? status(message.id)
        : message?.type === "suggest"
          ? suggest(message.field, message.q)
          : message?.type === "settings"
            ? settings()
            : message?.type === "logins"
              ? logins()
              : message?.type === "sendLogin"
                ? sendLogin(message.name, message.sites)
                : message?.type === "forgetLogin"
                  ? ask("DELETE", `/downloaders/${message.name}/cookies`)
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

// The address of the page on show is only told to the extension for the
// press itself, which the `activeTab` permission is for.
chrome.action.onClicked.addListener(async (tab) => {
  const result = tab.url
    ? await send(tab.url)
    : { error: "the address of this page could not be read" };
  report(tab, result);
});
