// Reddit: a button at the end of each post's title, in feeds and on the
// post's own page, in the new design and the old.

/** A post's address from the path Reddit gives it. */
const redditUrl = (permalink) => new URL(permalink, location.origin).href;

function redditScan() {
  // The new design: each post is a <shreddit-post> that says its own
  // address, with its title in the slot of that name.
  for (const post of document.querySelectorAll("shreddit-post[permalink]:not([data-opalarchive])")) {
    const title = post.querySelector('[slot="title"]');
    if (!title) continue;
    post.dataset.opalarchive = "";
    title.append(opalButton(() => redditUrl(post.getAttribute("permalink"))));
  }
  // The old design, and search results there.
  for (const post of document.querySelectorAll(".thing.link[data-permalink]:not([data-opalarchive])")) {
    const title = post.querySelector("p.title > a.title");
    if (!title) continue;
    post.dataset.opalarchive = "";
    title.after(opalButton(() => redditUrl(post.dataset.permalink)));
  }
}

opalWatch(redditScan);
