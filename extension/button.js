// The button put beside a post, whatever the site: it sends the post's
// address to OpalArchive and shows what becomes of it. A site's own script
// only has to find the posts and say where each button goes.

/** How often OpalArchive is asked about something it is still working on. */
const OPAL_POLL = 1500;
/** Asked this many times at most: after that the button stops waiting. */
const OPAL_POLLS = 400;

const OPAL_ICONS = {
  idle: "M12 15.6 8.5 12l.7-.7 2.3 2.3V5h1v8.6l2.3-2.3.7.7zM6.6 19q-.7 0-1.1-.5T5 17.4V15h1v2.4q0 .2.2.4t.4.2h10.8q.2 0 .4-.2t.2-.4V15h1v2.4q0 .7-.5 1.1t-1.1.5z",
  done: "m9.5 17.3-4.6-4.6.7-.7 3.9 3.9 8.9-8.9.7.7z",
  failed: "M12 12.7 7.1 17.6l-.7-.7 4.9-4.9-4.9-4.9.7-.7 4.9 4.9 4.9-4.9.7.7-4.9 4.9 4.9 4.9-.7.7z",
};

const OPAL_TITLES = {
  idle: "Send to OpalArchive",
  sending: "Sending to OpalArchive…",
  queued: "Waiting in OpalArchive's queue",
  running: "OpalArchive is downloading it",
  done: "Downloaded to OpalArchive. Click to send it again.",
};

/** Asks the background part of the extension, which asks OpalArchive. */
function opalAsk(message) {
  return chrome.runtime.sendMessage(message).catch(() => ({
    // The extension was reloaded or updated under this page.
    error: "The extension was restarted: reload the page.",
  }));
}

/**
 * A button that sends `url()` to OpalArchive when pressed. The address is
 * asked for at the press, in case the post's has changed since.
 */
function opalButton(url) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "opalarchive-button";
  let busy = false;

  const show = (state, title) => {
    button.dataset.state = state;
    button.title = title ?? OPAL_TITLES[state] ?? "";
    button.setAttribute("aria-label", button.title);
    const waiting = state === "sending" || state === "queued" || state === "running";
    const path = OPAL_ICONS[state] ?? OPAL_ICONS.idle;
    button.innerHTML = waiting
      ? '<span class="opalarchive-spinner"></span>'
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
  };
  const fail = (why) => show("failed", `OpalArchive: ${why}. Click to try again.`);

  /** Follows a request until it has ended. */
  const follow = async (id) => {
    for (let asked = 0; asked < OPAL_POLLS; asked += 1) {
      await new Promise((resolve) => setTimeout(resolve, OPAL_POLL));
      const request = await opalAsk({ type: "status", id });
      if (request.error) return fail(request.error);
      if (request.status === "done") return show("done");
      if (request.status === "failed") return fail(request.message || "the download failed");
      if (request.status === "cancelled") return fail("the download was stopped");
      show(request.status);
    }
    show("idle");
  };

  button.addEventListener("click", async (event) => {
    // The button may sit inside the post's own link.
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    busy = true;
    show("sending");
    const request = await opalAsk({ type: "send", url: url() });
    if (request.error) fail(request.error);
    else {
      show(request.status);
      await follow(request.id);
    }
    busy = false;
  });
  // Nothing under the button is to take the press for its own.
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup"]) {
    button.addEventListener(type, (event) => event.stopPropagation());
  }
  show("idle");
  return button;
}

/**
 * Calls `scan` now and whenever the page gains something, as feeds do when
 * scrolled: at most once in a moment, however much is added.
 */
function opalWatch(scan) {
  let waiting = false;
  const soon = () => {
    if (waiting) return;
    waiting = true;
    setTimeout(() => {
      waiting = false;
      scan();
    }, 300);
  };
  scan();
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
}
