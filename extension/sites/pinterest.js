// Pinterest: a button on each pin of a grid, in the bottom left corner of
// its picture while the pointer is on it, as Pinterest's own are; one among
// Pinterest's own buttons on a pin's own page; and one on each board of a
// profile, which sends the whole board.
//
// Pinterest's class names mean nothing and change; what is relied on here
// is the address of a pin's link, and the names it gives its parts for its
// own tests (`data-test-id`). Those differ between its pages for visitors
// and for someone logged in, and change too: so on a pin's own page, where
// there must be a button, it goes on the pin's picture if Pinterest's
// buttons cannot be found, and in the corner of the window failing that.

/** The number of the pin an address is of. A slug may come before it. */
const pinId = (href) => /\/pin\/(?:[^/]*--)?(\d+)/.exec(href ?? "")?.[1];
const pinUrl = (id) => `${location.origin}/pin/${id}/`;

/** The names Pinterest has given the pin on show on its own page, likeliest first. */
const PIN_MAIN = ["CloseupMainPin", "closeup-body", "closeup-visual-container", "visual-content-container"];
/** And, inside it, its picture or video. */
const PIN_SHOWN = ["pin-closeup-image", "closeup-container", "closeup-image", "visual-content-container"];

const byTestId = (within, names) => {
  for (const name of names) {
    const found = within?.querySelector(`[data-test-id="${name}"]`);
    if (found) return found;
  }
  return null;
};

/** Pinterest's own buttons over a pin on its page: ours goes after the last. */
const PIN_ACTIONS = ["more-actions-button", "ellipsis-button", "share-button", "react-button"];

/** Icons further apart than this, in pixels, are not of the same row. */
const PIN_GAP = 100;

/**
 * The last two of Pinterest's own buttons over the pin, found by their
 * names; `null` if fewer than two are named as expected.
 */
function pinterestNamedActions(within) {
  const found = PIN_ACTIONS.map((name) => within.querySelector(`[data-test-id="${name}"]`)).filter(Boolean);
  const other = found.find((action) => !found[0].contains(action) && !action.contains(found[0]));
  return other ? [found[0], other] : null;
}

/**
 * The same, found by what they look like where their names are not known:
 * a line of at least three icons, in the nearest thing around the pin's
 * picture that has one. Answers with the last of the line, and the one
 * before it.
 */
function pinterestIconRow(shown) {
  // The picture itself, the largest there: what is laid over it, as a
  // video's controls are, is not the row.
  const area = (box) => box.width * box.height;
  const picture = [...(shown?.querySelectorAll("img, video") ?? [])]
    .map((media) => media.getBoundingClientRect())
    .sort((a, b) => area(b) - area(a))[0];
  const over = (icon) => {
    if (!picture) return shown.contains(icon);
    const box = icon.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    return x > picture.left && x < picture.right && y > picture.top && y < picture.bottom;
  };
  const cell = (icon) => icon.closest('[data-grid-item], [data-test-id="pin"], [data-test-id="pinWrapper"]');
  for (let around = shown; around && around !== document.body; around = around.parentElement) {
    const icons = [...around.querySelectorAll('button, [role="button"], a[href]')].filter(
      (icon) =>
        icon.querySelector("svg") &&
        // An icon and no words: a count, as of likes, is not words. What
        // has a name written on it, as the board to save to, is something
        // else that happens to be on the same line.
        /^[\d.,\s]*[kKmM]?$/.test(icon.textContent.trim()) &&
        // One with a button inside it is not the button.
        !icon.querySelector('button, [role="button"]') &&
        !over(icon) &&
        !icon.closest(".opalarchive-button") &&
        // Not the buttons of another pin, in a grid beside this one. The
        // pin on show can sit in a cell of a grid itself.
        !(cell(icon) && !cell(icon).contains(shown)) &&
        pinterestVisible(icon),
    );
    // A line of them: those whose middles are level, within a few pixels.
    const middle = (icon) => {
      const box = icon.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    for (const first of icons) {
      const line = icons
        .filter((icon) => Math.abs(middle(icon) - middle(first)) < 8)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      // Only those that stand together: the line is cut where there is a
      // wide gap, and the run this one is in is what counts.
      const runs = [[]];
      for (const icon of line) {
        const run = runs[runs.length - 1];
        const gap = run.length
          ? icon.getBoundingClientRect().left - run[run.length - 1].getBoundingClientRect().right
          : 0;
        if (gap > PIN_GAP) runs.push([icon]);
        else run.push(icon);
      }
      const run = runs.find((run) => run.includes(first));
      if (run.length >= 3) return [run[run.length - 1], run[run.length - 2]];
    }
  }
  return null;
}

/**
 * Puts the pin's button in the row of Pinterest's own, after the last of
 * them, and answers with it; `null` if the row was not found. The row is
 * not always inside what Pinterest calls the pin, so the whole page is
 * looked through for it too.
 */
function pinterestInBar(main, shown) {
  const had = document.querySelector(".opalarchive-button.opalarchive-bar");
  // One left from another pin, when the page went on to this one, would
  // still say what became of that one.
  if (had?.dataset.pin === pinId(location.pathname)) return had;
  had?.remove();
  const actions =
    (main && pinterestNamedActions(main)) ?? pinterestNamedActions(document) ?? pinterestIconRow(shown);
  if (!actions) return null;
  // Two of them say where the row is: it is what holds them both, and its
  // last part is the one holding the last of them.
  let [last, other] = actions;
  while (last.parentElement && !last.parentElement.contains(other)) last = last.parentElement;
  if (!last.parentElement) return null;
  const button = opalButton(() => pinUrl(pinId(location.pathname)));
  button.classList.add("opalarchive-bar");
  button.dataset.pin = pinId(location.pathname);
  last.after(button);
  return button;
}

/**
 * Keeps a pin's button in the bottom left corner of its picture, which is
 * not all of its cell: a title may come under it. Placed when the pointer
 * comes, which is when it shows.
 */
function pinterestOnPicture(cell) {
  const button = cell.querySelector(":scope > .opalarchive-button");
  if (!button || button.classList.contains("opalarchive-hover")) return;
  button.classList.add("opalarchive-hover");
  cell.classList.add("opalarchive-holder");
  const place = () => {
    const picture = cell.querySelector("img, video");
    if (!picture) return;
    const [around, at] = [cell.getBoundingClientRect(), picture.getBoundingClientRect()];
    button.style.top = `${at.bottom - around.top - button.offsetHeight - 12}px`;
    button.style.left = `${at.left - around.left + 12}px`;
  };
  place();
  cell.addEventListener("pointerenter", place);
}

/** Whether something is on show, and takes up room on the page. */
function pinterestVisible(element) {
  if (!element?.isConnected) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
}

/** The button in the corner of the window, for a pin's page with no other. */
let pinterestFloat = null;

function pinterestScan() {
  // The pin whose page this is: its picture or video, wherever its page
  // has gone to since the button was put there.
  const here = pinId(location.pathname);
  const main = byTestId(document, PIN_MAIN);
  let shown = byTestId(main, PIN_SHOWN) ?? main;
  // A picture cannot hold a button: what it sits in can.
  while (shown && /^(IMG|VIDEO|PICTURE)$/.test(shown.tagName)) shown = shown.parentElement;
  // Among Pinterest's own buttons if they are found, and on the picture
  // if not.
  let placed = here ? pinterestInBar(main, shown) : null;
  if (placed) {
    shown?.querySelector(":scope > .opalarchive-button")?.remove();
  } else if (shown && here) {
    opalOverButton(shown, () => pinUrl(pinId(location.pathname)));
    placed = shown.querySelector(":scope > .opalarchive-button");
  }
  if (!here) document.querySelector(".opalarchive-button.opalarchive-bar")?.remove();
  // A pin's page always has a button: where neither was found, or the
  // button cannot be seen, one in the corner of the window.
  if (here && !pinterestVisible(placed)) {
    if (!pinterestFloat?.isConnected) {
      pinterestFloat = opalButton(() => pinUrl(pinId(location.pathname)));
      pinterestFloat.classList.add("opalarchive-over", "opalarchive-float");
      document.body.append(pinterestFloat);
    }
  } else {
    pinterestFloat?.remove();
    pinterestFloat = null;
  }

  // The pins of a grid: each is a link to its page, in a cell of the grid.
  for (const link of document.querySelectorAll('a[href*="/pin/"]')) {
    if (!pinId(link.getAttribute("href")) || main?.contains(link)) continue;
    const cell =
      link.closest('[data-test-id="pin"]') ??
      link.closest('[data-test-id="pinWrapper"]') ??
      link.closest("[data-grid-item]");
    // A link in passing, in a comment say, is not a pin on show.
    if (!cell || cell.contains(main)) continue;
    // Read at the press: a cell is used again for other pins as the grid
    // is scrolled.
    opalOverButton(cell, () => {
      const now = cell.querySelector('a[href*="/pin/"]')?.getAttribute("href");
      return pinUrl(pinId(now) ?? pinId(link.getAttribute("href")));
    });
    pinterestOnPicture(cell);
  }

  // The boards of a profile: the button sends the board, with all its pins.
  for (const card of document.querySelectorAll('[data-test-id="board-card"]')) {
    const link = card.querySelector("a[href]");
    if (link) {
      opalOverButton(card, () => new URL(link.getAttribute("href"), location.origin).href, "board");
    }
  }
}

opalWatch(pinterestScan);
