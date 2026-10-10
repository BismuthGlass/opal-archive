// Pinterest: a button on the corner of each pin, in grids and on the pin's
// own page, and on each board of a profile, which sends the whole board.
//
// Pinterest's class names mean nothing and change; what is relied on here
// is the address of a pin's link, and the names it gives its parts for its
// own tests (`data-test-id`). Those differ between its pages for visitors
// and for someone logged in, and change too: so on a pin's own page, where
// there must be a button, one is put in the corner of the window if the
// pin's picture cannot be found to put it on.

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
  if (shown && here) {
    opalOverButton(shown, () => pinUrl(pinId(location.pathname)));
  }
  // A pin's page always has a button: where the pin's picture was not
  // found, or the button put on it cannot be seen, one in the corner of
  // the window.
  const placed = shown?.querySelector(":scope > .opalarchive-button");
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
