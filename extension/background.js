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
 * downloads. Answers with the request made. `children` is false when the
 * tags are to be given as they stand, the child tags they bring having
 * been shown already; left out, OpalArchive brings them itself.
 */
const send = (url, tags = [], children) =>
  ask("POST", "/inbox", children === false ? { url, tags, children } : { url, tags });
/** What has become of a request. */
const status = (id) => ask("GET", `/inbox/queue/${id}`);
/** The tags of a type that match what has been typed, as OpalArchive suggests them. */
const suggest = (field, q) => ask("GET", `/tags?${new URLSearchParams({ field, q })}`);
/** Every tag that adding one brings: its child tags, and theirs. */
const childrenOf = (field, value) =>
  ask("GET", `/tags/children?${new URLSearchParams({ field, value })}`);
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
      ? send(message.url, message.tags, message.children)
      : message?.type === "status"
        ? status(message.id)
        : message?.type === "suggest"
          ? suggest(message.field, message.q)
          : message?.type === "children"
            ? childrenOf(message.field, message.value)
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
// button in the page: the picture or video, the page itself, or a link.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "send",
    title: "Send to OpalArchive",
    contexts: ["page", "image", "video", "audio"],
  });
  // A picture is often a link to a larger one, or to the post it is of:
  // this sends where the link goes instead of the picture.
  chrome.contextMenus.create({
    id: "sendLink",
    title: "Send link to OpalArchive",
    contexts: ["link"],
  });
  // In the menu of the extension's own button, which a right-click on it opens.
  chrome.contextMenus.create({
    id: "open",
    title: "Open OpalArchive",
    contexts: ["action"],
  });
});

/** Shows OpalArchive: the tab it is open in if there is one, a new one if not. */
async function openApp() {
  const at = await server();
  const origin = originOf(at);
  const { id: here } = await chrome.windows.getLastFocused();
  const open = (await chrome.tabs.query({})).filter((tab) => originOf(tab.url) === origin);
  // One in the window being looked at is nearer than one in another.
  const tab = open.find((tab) => tab.windowId === here) ?? open[0];
  if (!tab) return chrome.tabs.create({ url: at });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

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

/** Whether a site has a downloader of its own, as OpalArchive lists them. */
async function hasOwnDownloader(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const all = await ask("GET", "/inbox/sites");
  return (Array.isArray(all) ? all : []).some((downloader) =>
    downloader.sites.some((site) => ofSite(host, site)),
  );
}

/**
 * What "Send to OpalArchive" sends for a picture or video: the file
 * itself if its site has a downloader, or none does and the page's site
 * has none either; the page if that has one, as it knows what the picture
 * is of. A file that has no address of its own on the web, as a video
 * played from a `blob:` has not, is sent as the page.
 */
async function mediaTarget(src, page) {
  if (!/^https?:/.test(src ?? "")) return page;
  if (!page || (await hasOwnDownloader(src))) return src;
  return (await hasOwnDownloader(page)) ? page : src;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "open") return openApp();
  const url =
    info.menuItemId === "sendLink"
      ? info.linkUrl
      : info.srcUrl
        ? await mediaTarget(info.srcUrl, info.pageUrl)
        : info.pageUrl;
  if (url) report(tab, await send(url));
});

// Another OpalArchive: when the page on show is an OpalArchive that is not
// the one the extension sends to, its button says so, and a press on it
// has the extension send to that one from then on. One browser is thus
// turned from a copy being tried out to the one that is kept, and back,
// by opening the one wanted.

/** The mark on the button while the page on show is another OpalArchive. */
const OTHER = "⇄";

/** The place a page's address is of, `http://127.0.0.1:7878`, if it has one. */
function originOf(url) {
  try {
    const { protocol, origin } = new URL(url ?? "");
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}

/** What has been found out about each place lately: whether it is an OpalArchive. */
const found = new Map();
const FOUND_FOR = 30_000;

/** Whether an OpalArchive answers at a place. */
async function isOpalArchive(origin) {
  const known = found.get(origin);
  if (known && Date.now() - known.at < FOUND_FOR) return known.is;
  let is = false;
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) });
    const health = response.ok ? await response.json() : null;
    // Its health check says how far its library's layout has come.
    is = health?.status === "ok" && Number.isInteger(health?.schema_version);
  } catch {
    // Nothing there, or nothing the extension may ask.
  }
  found.set(origin, { is, at: Date.now() });
  return is;
}

/** The OpalArchive a tab shows, if it is one and not the one sent to. */
async function otherOpalArchive(tab) {
  const origin = originOf(tab?.url);
  if (!origin || origin === (await server())) return null;
  return (await isOpalArchive(origin)) ? origin : null;
}

/** Marks the button for a tab that shows another OpalArchive, and unmarks it otherwise. */
async function look(tab) {
  if (!tab?.id) return;
  const other = await otherOpalArchive(tab);
  const marked = (await chrome.action.getBadgeText({ tabId: tab.id }).catch(() => "")) === OTHER;
  if (other) {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#e8590c" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: OTHER });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `This is another OpalArchive. Click to send to it from now on (now: ${await server()})`,
    });
  } else if (marked) {
    // Only its own mark is taken off: one left by something sent stays.
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "" });
  }
}

// The address of a tab is only told to the extension for the places it is
// let onto: this computer, and any other OpalArchive it has been pointed at.
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status === "complete" || change.url) look(tab).catch(() => {});
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  look(await chrome.tabs.get(tabId).catch(() => null)).catch(() => {});
});
// Pointed elsewhere, in the options or by a press: the tabs are looked at again.
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.server) return;
  for (const tab of await chrome.tabs.query({})) look(tab).catch(() => {});
});

/** Has the extension send to another OpalArchive from now on. Says how it went. */
async function switchTo(origin) {
  // Anywhere but this computer, the browser has to be asked once.
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (!local) {
    const allowed = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!allowed) return { error: `not allowed to reach ${origin}: set it in the options` };
  }
  await chrome.storage.sync.set({ server: origin });
  return { switched: origin };
}

// The address of the page on show is only told to the extension for the
// press itself, which the `activeTab` permission is for.
chrome.action.onClicked.addListener(async (tab) => {
  // On another OpalArchive, the press is for sending to it from now on.
  const other = await otherOpalArchive(tab).catch(() => null);
  if (other) {
    const result = await switchTo(other);
    await report(tab, result);
    if (result.switched) {
      await chrome.action.setTitle({ tabId: tab.id, title: `Now sending to ${other}` });
    }
    return;
  }
  const result = tab.url
    ? await send(tab.url)
    : { error: "the address of this page could not be read" };
  report(tab, result);
});
