// 4chan: a button beside the file of each post that has one, which sends
// that post, and one beside each thread's first post, which sends the
// whole thread. In a board's catalog, each thread has the thread's button
// on its corner.
//
// 4chan X shows a quoted post inside the one quoting it, and a hovered one
// in a box of its own, by copying the post, buttons and all; but a copied
// button does nothing when pressed. So the buttons this script made are
// kept, and any other found on a post is put back with one that works.

/** The board a page is of: the first part of its path. */
const chanBoard = () => location.pathname.split("/")[1];
const chanThread = (thread, board = chanBoard()) =>
  `https://boards.4chan.org/${board}/thread/${thread}`;

/** The buttons made here, as against copies of them. */
const chanMade = new WeakSet();

/** Whether `element` belongs to `post` itself, not to a post shown in it. */
const chanOwn = (post, element) => element.closest(".post") === post;

/**
 * The address of a post, from its own link: so a post from another thread,
 * or board, shown in this one is sent as itself. Without that link, it goes
 * by the thread it sits in.
 */
function chanPost(post) {
  for (const link of post.querySelectorAll(".postNum a[href*='#p']")) {
    if (!chanOwn(post, link)) continue;
    const found = link.href.match(/\/(\w+)\/thread\/(\d+)[^#]*#p(\d+)/);
    if (found) return { board: found[1], thread: found[2], number: found[3] };
  }
  const number = post.id.match(/^p(\d+)$/)?.[1];
  const thread = post.closest(".thread")?.id.match(/^t(\d+)$/)?.[1];
  return number && thread ? { board: chanBoard(), thread, number } : null;
}

/**
 * Puts a working button where `place` says, unless `post` has one in
 * `line` already: a copied one is taken away first.
 */
function chanPlace(post, line, selector, make, place) {
  const old = [...line.querySelectorAll(selector)].find((button) => chanOwn(post, button));
  if (old && chanMade.has(old)) return;
  old?.remove();
  const button = make();
  chanMade.add(button);
  place(button);
}

function chanScan() {
  // Posts, on a thread's page and on a board's, and those 4chan X shows
  // inside others or on hover. A post is `div.post`, `#p<number>` unless a
  // copy.
  for (const post of document.querySelectorAll(".post")) {
    const at = chanPost(post);
    if (!at) continue;

    // A first post's button, for the thread, goes by its number.
    if (post.classList.contains("op")) {
      const info = [...post.querySelectorAll(".postInfo")].find((info) => chanOwn(post, info));
      if (info) {
        const make = () => {
          const button = opalButton(() => chanThread(at.thread, at.board), "thread");
          button.classList.add("opalarchive-thread");
          return button;
        };
        chanPlace(post, info, ".opalarchive-thread", make, (button) =>
          (info.querySelector(".postNum") ?? info.lastElementChild ?? info).after(button),
        );
      }
    }

    // A post's button goes at the end of the line that names its file. A
    // post with no file, or whose file was deleted, has nothing to send.
    const file = [...post.querySelectorAll(".file .fileText")].find((line) => chanOwn(post, line));
    if (!file) continue;
    const make = () => opalButton(() => `${chanThread(at.thread, at.board)}#p${at.number}`);
    chanPlace(post, file, ".opalarchive-button:not(.opalarchive-thread)", make, (button) => file.append(button));
  }

  // The catalog: each thread is `div.thread#thread-<number>`, a picture
  // with a line or two under it.
  for (const thread of document.querySelectorAll("#threads > .thread[id^='thread-']")) {
    const number = thread.id.slice("thread-".length);
    if (/^\d+$/.test(number)) opalOverButton(thread, () => chanThread(number), "thread");
  }
}

opalWatch(chanScan);
