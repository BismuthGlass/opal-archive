# The OpalArchive browser extension

It sends posts to OpalArchive to be downloaded, without leaving the page
they are on. OpalArchive does the downloading: the extension only passes on
an address, which goes into the inbox's queue (see `downloaders/README.md`).

- On Reddit, a small button at the end of each post's title. Pressing it
  asks for tags to give what is downloaded, entered as in OpalArchive's own
  tag editor: typing suggests the tags there are, `@cr:name` is a tag of
  another type, Enter adds one, and Shift+Enter (or Download) sends the
  post. Shift-click on the button sends it at once, with no tags. The
  button turns into a spinner while the post waits and downloads, then a
  tick, or a cross. A download that goes wrong is also said in the bottom
  right corner of the page: pressing the notice opens it, with why and a
  way to try again. Pressing the button again sends the post again.
- On Pinterest, the same button in the bottom left corner of each pin's
  picture in a grid, shown while the pointer is on the pin as Pinterest's
  own buttons are, and for as long as it has something to say of what was
  sent. On a pin's own page it is in the row of Pinterest's buttons over
  the pin, after the last of them; if that row cannot be found it is on
  the pin's picture, and failing that in the bottom left corner of the
  window. On each board of a profile it sends the whole board.
- On 4chan, the button at the end of the line that names each post's
  file, which sends that post, and one by the number of each thread's
  first post, which sends the whole thread. In a board's catalog each
  thread has the thread's button on its corner.
- Everywhere, "Send to OpalArchive" in the right-click menu, for a link or
  the page itself, and the extension's own button for the page on show.
  These work for any site OpalArchive has a downloader for.

Its options also list the downloaders that use a login, with whether
OpalArchive has one saved. "Send my login" gives OpalArchive this
browser's cookies for that site, and no other's, so that it can download
what the site shows only to you; "Forget" has it delete them. This is the
way to log in an OpalArchive that runs on another machine, which has no
browser of yours to read the login from.

It sends to one OpalArchive, the one set in its options. When the page on
show is another OpalArchive, a copy being worked on beside the one that is
kept, say, the extension's button is marked ⇄, and a press on it has the
extension send to that one from then on. This is noticed by itself for an
OpalArchive on this computer, which is where a tunnel to one elsewhere
ends too; for one at another address the press finds it out.

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
