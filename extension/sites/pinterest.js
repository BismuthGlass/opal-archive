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

/**
 * Puts the pin's button in the row of Pinterest's own, after the last of
 * them, and answers with it; `null` if the row was not found.
 */
function pinterestInBar(within) {
  const had = document.querySelector(".opalarchive-button.opalarchive-bar");
  // One left from another pin, when the page went on to this one, would
  // still say what became of that one.
  if (had?.dataset.pin === pinId(location.pathname)) return had;
  had?.remove();
  const found = PIN_ACTIONS.map((name) => within.querySelector(`[data-test-id="${name}"]`)).filter(Boolean);
  // Two of them say where the row is: it is what holds them both.
  const other = found.find((action) => !found[0].contains(action) && !action.contains(found[0]));
  if (!other) return null;
  // The last of the row is the part of it that holds the first one found.
  let last = found[0];
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
  let placed = here ? pinterestInBar(main ?? document) : null;
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
