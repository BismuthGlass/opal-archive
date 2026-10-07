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
  idle: "Send to OpalArchive (Shift-click to skip the tags)",
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

/** The box asking for tags, while one is open: there is one at a time. */
let opalAsking = null;

/**
 * Opens a small box under `anchor` asking for tags to give the download.
 * `submit` is handed them when Download is pressed, and answers with what
 * went wrong, if anything: the box stays open to say so. It closes once
 * the download is on its way, or when put away.
 */
function opalAskTags(anchor, submit) {
  opalAsking?.();
  const box = document.createElement("form");
  box.className = "opalarchive-popup";
  box.innerHTML = `
    <label for="opalarchive-tags">Tags to add</label>
    <input id="opalarchive-tags" type="text" autocomplete="off" spellcheck="false"
           placeholder="cat, @cr:someone" />
    <p class="opalarchive-hint">Separated by commas. Leave it empty for none.</p>
    <p class="opalarchive-error" role="alert" hidden></p>
    <div class="opalarchive-actions">
      <button type="button" data-do="cancel">Cancel</button>
      <button type="submit">Download</button>
    </div>`;
  const input = box.querySelector("input");
  const error = box.querySelector(".opalarchive-error");

  const close = () => {
    opalAsking = null;
    document.removeEventListener("pointerdown", outside, true);
    box.remove();
  };
  // A press anywhere else puts it away.
  const outside = (event) => {
    if (!box.contains(event.target)) close();
  };
  opalAsking = close;

  box.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tags = input.value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    box.querySelector('[type="submit"]').disabled = true;
    const wrong = await submit(tags);
    if (!box.isConnected) return;
    if (wrong) {
      error.textContent = wrong;
      error.hidden = false;
      box.querySelector('[type="submit"]').disabled = false;
      input.focus();
      return;
    }
    // Offered again the next time: posts are often tagged in runs.
    chrome.storage.local.set({ lastTags: tags.join(", ") }).catch(() => {});
    close();
  });
  // What it said was wrong is being put right.
  input.addEventListener("input", () => (error.hidden = true));
  box.querySelector('[data-do="cancel"]').addEventListener("click", close);
  // What is typed here is not for the page's own shortcuts.
  for (const type of ["keydown", "keyup", "keypress"]) {
    box.addEventListener(type, (event) => {
      event.stopPropagation();
      if (type === "keydown" && event.key === "Escape") close();
    });
  }
  for (const type of ["click", "mousedown", "mouseup", "pointerup"]) {
    box.addEventListener(type, (event) => event.stopPropagation());
  }

  // Under the button, kept inside the window; it moves with the page.
  document.body.append(box);
  const at = anchor.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8));
  const below = at.bottom + 6 + size.height <= window.innerHeight;
  const top = below ? at.bottom + 6 : Math.max(8, at.top - size.height - 6);
  box.style.left = `${left + window.scrollX}px`;
  box.style.top = `${top + window.scrollY}px`;
  document.addEventListener("pointerdown", outside, true);

  // The tags used last are there to be used again, or typed over.
  chrome.storage.local
    .get({ lastTags: "" })
    .catch(() => ({ lastTags: "" }))
    .then(({ lastTags }) => {
      if (!box.isConnected || input.value) return;
      input.value = lastTags;
      input.select();
    });
  input.focus();
}

/**
 * A button that sends `url()` to OpalArchive when pressed, after asking for
 * tags to add; with Shift held it sends at once, with none. The address is
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

  /** Sends the post with these tags. Answers with what went wrong, if anything. */
  const send = async (tags) => {
    const before = button.dataset.state;
    busy = true;
    show("sending");
    const request = await opalAsk({ type: "send", url: url(), tags });
    if (request.error) {
      busy = false;
      // The box that asked says why; the button is as it was.
      show(before === "done" || before === "failed" ? "idle" : before);
      return request.error;
    }
    show(request.status);
    follow(request.id).finally(() => (busy = false));
    return null;
  };

  button.addEventListener("click", async (event) => {
    // The button may sit inside the post's own link.
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (event.shiftKey) {
      const wrong = await send([]);
      if (wrong) fail(wrong);
    } else {
      opalAskTags(button, send);
    }
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
