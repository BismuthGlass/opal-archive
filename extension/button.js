// The button put beside a post, whatever the site: it sends the post's
// address to OpalArchive and shows what becomes of it. A site's own script
// only has to find the posts and say where each button goes.

/** How often OpalArchive is asked about something it is still working on. */
const OPAL_POLL = 1500;
/** Asked this many times at most: after that the button stops waiting. */
const OPAL_POLLS = 400;

/** The mark of a button that sends many things at once: a thread, a board. */
const OPAL_MANY =
  "M9.2 13.7h8.6l-2.7-3.7-2.5 3.1-1.6-1.9zM8.1 17q-.7 0-1.1-.5t-.5-1.1V4.6q0-.7.5-1.1T8.1 3h10.8q.7 0 1.1.5t.5 1.1v10.8q0 .7-.5 1.1t-1.1.5zm0-1h10.8q.2 0 .4-.2t.2-.4V4.6q0-.2-.2-.4t-.4-.2H8.1q-.2 0-.4.2t-.2.4v10.8q0 .2.2.4t.4.2m-3 4q-.7 0-1.1-.5t-.5-1.1V6.6h1v11.8q0 .2.2.4t.4.2h11.8v1z";

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

// The tag types, as OpalArchive has them: each one's name, the short name
// it goes by after an @, and the colours of its pills unless the user has
// chosen others. `@cr:name` is the creator `name`; a tag with no @ is a
// plain one, of type `tags`.
const OPAL_TYPES = [
  ["tags", "ta", "#e3e6ea", "#22262b"],
  ["creator", "cr", "#ffd8a8", "#5c2a00"],
  ["character", "ch", "#c5efcf", "#0b4a1e"],
  ["source_work", "sw", "#d5dbff", "#1b236e"],
  ["person", "pe", "#ffd2df", "#6b0f2c"],
  ["genre", "ge", "#e5d3ff", "#3e1378"],
  ["style", "st", "#c6f0f1", "#06484c"],
  ["medium", "me", "#f2e2c2", "#513a06"],
  ["flaws", "fl", "#ffd0cb", "#7a1410"],
  ["language", "la", "#d1ebff", "#0a3c65"],
  ["source", "so", "#e2e8c6", "#374209"],
  ["usage_tags", "us", "#ffe8a3", "#594200"],
  ["ai_usage_tags", "ai", "#d8d5e8", "#2e2949"],
  ["bucket", "bu", "#3b4252", "#f1f3f7"],
].map(([field, prefix, bg, fg]) => ({ field, prefix, bg, fg }));

/** How many suggestions are listed at once. */
const OPAL_SUGGESTIONS = 8;
/** How much of a tag has to be typed before tags are suggested for it. */
const OPAL_TYPED = 2;

const opalType = (field) => OPAL_TYPES.find((type) => type.field === field);
const opalLabel = (field) => field.charAt(0).toUpperCase() + field.slice(1).replaceAll("_", " ");
/** A tag as it is typed, and sent: `name`, or `@cr:name`. */
const opalText = (tag) =>
  tag.field === "tags" ? tag.value : `@${opalType(tag.field).prefix}:${tag.value}`;

/**
 * Reads a tag as typed: `name` is a plain tag, `@cr:name` a creator. The
 * first colon ends the type; any after it belong to the tag's namespaces.
 * `naming` is set while only `@…` has been typed: the start of a type's name.
 */
function opalRead(text) {
  const typed = text.trimStart();
  if (!typed.startsWith("@")) return { field: "tags", value: typed.trim(), lead: "", naming: null };
  const colon = typed.indexOf(":");
  if (colon < 0) return { field: null, value: "", lead: "", naming: typed.slice(1) };
  const name = typed.slice(1, colon).trim().toLowerCase();
  const type = OPAL_TYPES.find((type) => type.prefix === name || type.field === name);
  return {
    field: type?.field ?? null,
    value: typed.slice(colon + 1).trim(),
    lead: typed.slice(0, colon + 1),
    naming: null,
  };
}

/** The colours the user has given the tag types in OpalArchive, asked for once. */
let opalColours = null;
function opalPillStyle(element, field) {
  const type = opalType(field);
  element.style.background = type.bg;
  element.style.color = type.fg;
  opalColours ??= opalAsk({ type: "settings" }).then((settings) => settings?.tagTypes ?? {});
  opalColours.then((chosen) => {
    if (chosen[field]?.bg) element.style.background = chosen[field].bg;
    if (chosen[field]?.fg) element.style.color = chosen[field].fg;
  });
}

/** An element with a class, and text if any. */
function opalElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The box asking for tags, while one is open: there is one at a time. */
let opalAsking = null;

/**
 * Opens a small box under `anchor` asking for tags to give the download,
 * entered as in OpalArchive's own tag editor: typing suggests the tags
 * there are, Enter adds one, and Shift+Enter downloads. `submit` is handed
 * the tags, as typed, and answers with what went wrong, if anything: the
 * box stays open to say so. It closes once the download is on its way, or
 * when put away.
 */
function opalAskTags(anchor, submit) {
  opalAsking?.();
  const box = opalElement("form", "opalarchive-popup");
  box.innerHTML = `
    <label for="opalarchive-tags">Tags to add</label>
    <div class="opalarchive-pills" hidden></div>
    <input id="opalarchive-tags" type="text" role="combobox" autocomplete="off"
           spellcheck="false" aria-autocomplete="list" aria-expanded="true"
           aria-controls="opalarchive-suggestions"
           placeholder="Add a tag. @cr:name for another type" />
    <ul id="opalarchive-suggestions" class="opalarchive-suggestions" role="listbox"></ul>
    <p class="opalarchive-error" role="alert" hidden></p>
    <button type="button" class="opalarchive-last" hidden></button>
    <div class="opalarchive-actions">
      <span class="opalarchive-hint">Enter adds · Shift+Enter downloads</span>
      <button type="button" data-do="cancel">Cancel</button>
      <button type="submit">Download</button>
    </div>`;
  const input = box.querySelector("input");
  const pills = box.querySelector(".opalarchive-pills");
  const list = box.querySelector(".opalarchive-suggestions");
  const error = box.querySelector(".opalarchive-error");
  const last = box.querySelector(".opalarchive-last");
  const download = box.querySelector('[type="submit"]');

  /** The tags added so far. */
  const tags = [];
  /** The suggestions on show, and the one highlighted; -1 is the typed text. */
  let options = [];
  let active = -1;
  /** Counts what was asked of OpalArchive: a late answer is not shown. */
  let asked = 0;
  let waiting = 0;

  const complain = (text) => {
    error.textContent = text ?? "";
    error.hidden = !text;
  };

  const showTags = () => {
    pills.replaceChildren(
      ...tags.map((tag) => {
        const pill = opalElement("span", "opalarchive-pill");
        opalPillStyle(pill, tag.field);
        pill.title = `${opalLabel(tag.field)}: ${tag.value}`;
        pill.append(opalElement("span", "", tag.value));
        const off = opalElement("button", "opalarchive-off", "×");
        off.type = "button";
        off.setAttribute("aria-label", `Take off ${tag.value}`);
        off.addEventListener("click", () => {
          tags.splice(tags.indexOf(tag), 1);
          showTags();
          input.focus();
        });
        pill.append(off);
        return pill;
      }),
    );
    pills.hidden = tags.length === 0;
  };

  const showOptions = () => {
    list.replaceChildren(
      ...options.map((option, index) => {
        const row = opalElement("li", index === active ? "opalarchive-active" : "");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === active));
        if (option.kind === "type") {
          const sample = opalElement("span", "opalarchive-pill", opalLabel(option.field));
          opalPillStyle(sample, option.field);
          row.append(sample, opalElement("span", "opalarchive-note", `@${opalType(option.field).prefix}:`));
        } else {
          const value = opalElement("span", "opalarchive-value");
          if (option.alias) value.append(opalElement("span", "opalarchive-note", `${option.alias} → `));
          value.append(option.value);
          const note = option.has
            ? "already added"
            : [String(option.count), option.description].filter(Boolean).join(" · ");
          row.append(value, opalElement("span", "opalarchive-note", option.namespace ? `${note} ›` : note));
        }
        // Keeps the cursor in the box.
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => pick(option));
        return row;
      }),
    );
    list.hidden = options.length === 0;
  };

  const has = (field, value) =>
    tags.some((tag) => tag.field === field && tag.value.toLowerCase() === value.toLowerCase());

  /** Works out what to suggest for what is typed: the types, or a type's tags. */
  const suggest = () => {
    const { field, value, naming } = opalRead(input.value);
    active = -1;
    asked += 1;
    clearTimeout(waiting);
    if (naming !== null) {
      const start = naming.trim().toLowerCase();
      // The type whose short name was typed in full comes first: `@so` is
      // the source before it is the start of the source work.
      options = OPAL_TYPES.filter(
        (type) => type.prefix.startsWith(start) || type.field.startsWith(start),
      )
        .sort((a, b) => Number(b.prefix === start) - Number(a.prefix === start))
        .map((type) => ({ kind: "type", field: type.field }));
      return showOptions();
    }
    if (!field || value.length < OPAL_TYPED) {
      options = [];
      return showOptions();
    }
    // What is on show stays until the answer comes, a moment after the
    // last key.
    const mine = asked;
    waiting = setTimeout(async () => {
      const found = await opalAsk({ type: "suggest", field, q: value });
      if (mine !== asked || !box.isConnected) return;
      options = (Array.isArray(found) ? found : []).slice(0, OPAL_SUGGESTIONS).map((option) => ({
        kind: "tag",
        field,
        ...option,
        has: !option.namespace && has(field, option.value),
      }));
      showOptions();
    }, 120);
  };

  const write = (text) => {
    input.value = text;
    complain(null);
    suggest();
  };

  /** Adds what is typed, or what was picked, to the tags. Says whether it could. */
  const add = (field, value) => {
    const name = value.trim();
    if (!field) {
      complain(`${opalRead(input.value).lead.slice(0, -1)} is not a tag type. Type @ to see them.`);
      return false;
    }
    if (!name) return false;
    if (!has(field, name)) tags.push({ field, value: name });
    showTags();
    write("");
    return true;
  };

  const pick = (option) => {
    // A type writes its prefix, ready for the tag; a namespace steps into
    // it; a tag is added.
    if (option.kind === "type") write(`@${opalType(option.field).prefix}:`);
    else if (option.namespace) write(opalRead(input.value).lead + option.value);
    else add(option.field, option.value);
    input.focus();
  };

  const close = () => {
    opalAsking = null;
    clearTimeout(waiting);
    document.removeEventListener("pointerdown", outside, true);
    box.remove();
  };
  // A press anywhere else puts it away.
  const outside = (event) => {
    if (!box.contains(event.target)) close();
  };
  opalAsking = close;

  const send = async () => {
    // What is still in the box is meant too.
    const typed = opalRead(input.value);
    if (input.value.trim() && typed.naming === null && !add(typed.field, typed.value)) return;
    download.disabled = true;
    const wrong = await submit(tags.map(opalText));
    if (!box.isConnected) return;
    if (wrong) {
      complain(wrong);
      download.disabled = false;
      input.focus();
      return;
    }
    // Offered again the next time: posts are often tagged in runs.
    chrome.storage.local.set({ lastTags: tags }).catch(() => {});
    close();
  };

  box.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener("input", () => {
    complain(null);
    suggest();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = options.length;
      if (event.key === "ArrowDown") active = active + 1 >= count ? -1 : active + 1;
      else active = active < 0 ? count - 1 : active - 1;
      showOptions();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) return send();
      const typed = opalRead(input.value);
      if (active >= 0) pick(options[active]);
      // An unfinished `@…` names a type; it is never a tag.
      else if (typed.naming !== null) options.length > 0 && pick(options[0]);
      else add(typed.field, typed.value);
    } else if (event.key === "Backspace" && input.value === "" && tags.length > 0) {
      // With nothing typed, it takes the last tag off.
      tags.pop();
      showTags();
    }
  });
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
  showTags();
  showOptions();
  document.body.append(box);
  const at = anchor.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8));
  box.style.left = `${left + window.scrollX}px`;
  box.style.top = `${at.bottom + 6 + window.scrollY}px`;
  document.addEventListener("pointerdown", outside, true);

  // The tags used last can be had again with one press.
  chrome.storage.local
    .get({ lastTags: [] })
    .catch(() => ({ lastTags: [] }))
    .then(({ lastTags }) => {
      const again = (Array.isArray(lastTags) ? lastTags : []).filter(
        (tag) => opalType(tag?.field) && typeof tag.value === "string",
      );
      if (!box.isConnected || again.length === 0) return;
      last.textContent = `Use the last ones: ${again.map(opalText).join(", ")}`;
      last.hidden = false;
      last.addEventListener("click", () => {
        for (const tag of again) if (!has(tag.field, tag.value)) tags.push({ ...tag });
        showTags();
        last.hidden = true;
        input.focus();
      });
    });
  input.focus();
}

// Notices: what went wrong with something sent from this page, said in
// the bottom right corner of the page until dismissed. Pressing one opens
// it, to say what went wrong in full.

const OPAL_NOTICE_ICONS = {
  failed:
    "M12.4 16.3q.2-.2.2-.5t-.2-.4-.4-.2-.4.2-.2.4.2.5.4.1.4-.1m-.9-3.1h1v-6h-1zM12 21q-1.9 0-3.5-.7t-2.9-1.9-1.9-2.9T3 12t.7-3.5 1.9-2.9 2.9-1.9T12 3t3.5.7 2.9 1.9 1.9 2.9.7 3.5-.7 3.5-1.9 2.9-2.9 1.9-3.5.7m0-1q3.4 0 5.7-2.3T20 12t-2.3-5.7T12 4 6.3 6.3 4 12t2.3 5.7T12 20",
  problems:
    "M2.7 20 12 4l9.3 16zm1.7-1h15.2L12 6zm8-1.6q.2-.2.2-.4t-.2-.4-.4-.2-.4.2-.2.4.2.4.4.2.4-.2m-.9-2h1v-5h-1z",
};

/** How many notices are on show at once: the oldest give way. */
const OPAL_NOTICES = 4;

/**
 * Says in the corner that something sent from this page went wrong.
 * `kind` is `failed`, or `problems` for a download that got there without
 * everything. `retry`, if given, sends it again.
 */
function opalNotify({ kind, title, url, messages, retry }) {
  let stack = document.querySelector(".opalarchive-notices");
  if (!stack) {
    stack = opalElement("div", "opalarchive-notices");
    stack.setAttribute("aria-label", "OpalArchive notifications");
    document.body.append(stack);
  }
  const notice = { kind, title, url, messages, retry, when: new Date() };
  const card = opalElement("div", `opalarchive-notice opalarchive-${kind}`);
  card.setAttribute("role", "alert");
  const dismiss = () => {
    card.remove();
    if (!stack.children.length) stack.remove();
  };

  const open = opalElement("button", "opalarchive-notice-open");
  open.type = "button";
  open.title = "Show what went wrong";
  open.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${OPAL_NOTICE_ICONS[kind]}"/></svg>`;
  const text = opalElement("span", "opalarchive-notice-text");
  text.append(
    opalElement("strong", "", title),
    opalElement("span", "opalarchive-notice-summary", messages[0] ?? ""),
  );
  open.append(text);
  open.addEventListener("click", () => opalReadNotice(notice, dismiss));

  const close = opalElement("button", "opalarchive-notice-dismiss", "×");
  close.type = "button";
  close.title = "Dismiss";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", dismiss);

  card.append(open, close);
  stack.append(card);
  while (stack.children.length > OPAL_NOTICES) stack.firstElementChild.remove();
}

/** Opens a notice over the page: what was sent, and everything that went wrong. */
function opalReadNotice(notice, dismiss) {
  document.querySelector(".opalarchive-dialog")?.remove();
  const back = opalElement("div", "opalarchive-dialog");
  const box = opalElement("div", "opalarchive-dialog-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", notice.title);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };

  const link = opalElement("a", "", notice.url);
  link.href = notice.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  const facts = opalElement("dl", "opalarchive-facts");
  const address = opalElement("dd", "");
  address.append(link);
  facts.append(
    opalElement("dt", "", "Address"),
    address,
    opalElement("dt", "", "When"),
    opalElement("dd", "", notice.when.toLocaleString()),
  );
  const list = opalElement("ul", "opalarchive-messages");
  list.append(...notice.messages.map((message) => opalElement("li", "", message)));

  const actions = opalElement("div", "opalarchive-actions");
  const done = opalElement("button", "", "Dismiss");
  done.type = "button";
  done.addEventListener("click", () => {
    dismiss();
    close();
  });
  actions.append(done);
  if (notice.retry) {
    const again = opalElement("button", "opalarchive-primary", "Try again");
    again.type = "button";
    again.title = "Send it to OpalArchive again";
    again.addEventListener("click", () => {
      dismiss();
      close();
      notice.retry();
    });
    actions.append(again);
  }

  box.append(
    opalElement("h2", "", notice.title),
    facts,
    opalElement("p", "opalarchive-hint", notice.kind === "failed" ? "Why it failed" : "What went wrong"),
    list,
    actions,
  );
  back.append(box);
  // A press on what is behind it puts it away; one inside it is its own.
  back.addEventListener("click", (event) => event.target === back && close());
  for (const type of ["keydown", "keyup", "keypress", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    box.addEventListener(type, (event) => event.stopPropagation());
  }
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  (actions.querySelector(".opalarchive-primary") ?? done).focus();
}

/**
 * A button that sends `url()` to OpalArchive when pressed, after asking for
 * tags to add; with Shift held it sends at once, with none. The address is
 * asked for at the press, in case the post's has changed since.
 *
 * `many` names what it sends when that is more than one thing, "thread"
 * say: the button then looks the part, and says so when pointed at.
 */
function opalButton(url, many) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "opalarchive-button";
  let busy = false;
  const idle = many
    ? `Send the whole ${many} to OpalArchive (Shift-click to skip the tags)`
    : OPAL_TITLES.idle;

  const show = (state, title) => {
    button.dataset.state = state;
    button.title = title ?? (state === "idle" ? idle : OPAL_TITLES[state]) ?? "";
    button.setAttribute("aria-label", button.title);
    const waiting = state === "sending" || state === "queued" || state === "running";
    const path = state === "idle" && many ? OPAL_MANY : (OPAL_ICONS[state] ?? OPAL_ICONS.idle);
    button.innerHTML = waiting
      ? '<span class="opalarchive-spinner"></span>'
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
  };
  /** The address and tags last sent, to be sent again if asked. */
  let sent = { url: "", tags: [] };
  /** Shows that it failed, on the button and, unless `quiet`, in the corner. */
  const fail = (why, quiet = false) => {
    show("failed", `OpalArchive: ${why}. Click to try again.`);
    if (quiet) return;
    opalNotify({
      kind: "failed",
      title: "Download failed",
      url: sent.url,
      messages: why.split("; ").filter(Boolean),
      retry: () => busy || send(sent.tags).then((wrong) => wrong && fail(wrong)),
    });
  };

  /** Follows a request until it has ended. */
  const follow = async (id) => {
    for (let asked = 0; asked < OPAL_POLLS; asked += 1) {
      await new Promise((resolve) => setTimeout(resolve, OPAL_POLL));
      const request = await opalAsk({ type: "status", id });
      if (request.error) return fail(request.error);
      if (request.status === "done") {
        // It got there, though perhaps not with everything.
        if (request.message) {
          opalNotify({
            kind: "problems",
            title: "Download had problems",
            url: sent.url,
            messages: request.message.split("; ").filter(Boolean),
          });
        }
        return show("done");
      }
      if (request.status === "failed") return fail(request.message || "the download failed");
      // Stopped on purpose, in OpalArchive: there is nothing to tell.
      if (request.status === "cancelled") return fail("the download was stopped", true);
      show(request.status);
    }
    show("idle");
  };

  /** Sends the post with these tags. Answers with what went wrong, if anything. */
  const send = async (tags) => {
    const before = button.dataset.state;
    busy = true;
    show("sending");
    sent = { url: url(), tags };
    const request = await opalAsk({ type: "send", url: sent.url, tags });
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
 * Puts a button on the corner of `over`, unless it has one: for where
 * there is a picture and no line of text to sit in.
 */
function opalOverButton(over, url, many) {
  if (over.querySelector(":scope > .opalarchive-button")) return;
  // The button is placed against it.
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  const button = opalButton(url, many);
  button.classList.add("opalarchive-over");
  over.append(button);
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
