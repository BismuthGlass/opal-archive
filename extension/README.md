# The OpalArchive browser extension

It sends posts to OpalArchive to be downloaded, without leaving the page
they are on. OpalArchive does the downloading: the extension only passes on
an address, which goes into the inbox's queue (see `downloaders/README.md`).

- On Reddit, a small button at the end of each post's title. Pressing it
  asks for tags to give what is downloaded, written as in OpalArchive
  (`cat, @cr:someone`), and then Download sends the post; Shift-click sends
  it at once, with none. The button turns into a spinner while the post
  waits and downloads, then a tick, or a cross that says why when pointed
  at. Pressing it again sends the post again.
- Everywhere, "Send to OpalArchive" in the right-click menu, for a link or
  the page itself, and the extension's own button for the page on show.
  These work for any site OpalArchive has a downloader for.

What was sent is listed in OpalArchive's Inbox tab, until it is cleared
there.

## Installing it

It is not in any store. In Chrome, or a browser made from it (Brave, Edge,
Vivaldi):

1. Open `chrome://extensions` and turn on Developer mode.
2. Press "Load unpacked" and choose this folder.

It expects OpalArchive at `http://127.0.0.1:7878`. If yours is elsewhere,
set where in the extension's options; "Save and test" says whether it was
reached.

## Adding a site

A site needs a downloader in OpalArchive that names it in its `sites`; that
alone makes the right-click menu work there. For buttons in its pages, add a
script under `sites/` that finds the posts, and list it in `manifest.json`
beside Reddit's, after `button.js`:

```js
function scan() {
  for (const post of document.querySelectorAll(".post:not([data-opalarchive])")) {
    post.dataset.opalarchive = "";
    post.querySelector(".title").append(opalButton(() => post.querySelector("a").href));
  }
}
opalWatch(scan);
```

`opalButton` makes the button and follows what becomes of the download;
`opalWatch` calls the scan again as the page gains posts.
