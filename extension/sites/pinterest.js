// Pinterest: a button on the corner of each pin, in grids and on the pin's
// own page, and on each board of a profile, which sends the whole board.
//
// Pinterest's class names mean nothing and change; what is relied on here
// is the address of a pin's link, and the names it gives its parts for its
// own tests (`data-test-id`).

/** The number of the pin an address is of. A slug may come before it. */
const pinId = (href) => /\/pin\/(?:[^/]*--)?(\d+)/.exec(href ?? "")?.[1];
const pinUrl = (id) => `${location.origin}/pin/${id}/`;

/** Puts a button on the corner of `over`, unless it has one. */
function pinterestButton(over, url) {
  if (over.querySelector(":scope > .opalarchive-button")) return;
  // The button is placed against it.
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  const button = opalButton(url);
  button.classList.add("opalarchive-over");
  over.append(button);
}

function pinterestScan() {
  // The pin whose page this is: its picture or video, wherever its page
  // has gone to since the button was put there.
  const main = document.querySelector('[data-test-id="CloseupMainPin"]');
  const shown =
    main?.querySelector('[data-test-id="pin-closeup-image"]') ??
    main?.querySelector('[data-test-id="closeup-container"]') ??
    main;
  if (shown && pinId(location.pathname)) {
    pinterestButton(shown, () => pinUrl(pinId(location.pathname)));
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
    pinterestButton(cell, () => {
      const now = cell.querySelector('a[href*="/pin/"]')?.getAttribute("href");
      return pinUrl(pinId(now) ?? pinId(link.getAttribute("href")));
    });
  }

  // The boards of a profile: the button sends the board, with all its pins.
  for (const card of document.querySelectorAll('[data-test-id="board-card"]')) {
    const link = card.querySelector("a[href]");
    if (link) pinterestButton(card, () => new URL(link.getAttribute("href"), location.origin).href);
  }
}

opalWatch(pinterestScan);
