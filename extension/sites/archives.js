// The archives of 4chan, arch.b4k.dev, desuarchive.org and the rest, which
// all run FoolFuuka: the same buttons as on 4chan itself, beside the file
// of each post that has one, which sends that post, and by the number of
// each thread's first post, which sends the whole thread. OpalArchive's
// 4chan downloader takes the archive's addresses as they are.
//
// A post is `article.post`, a thread's first one `article.thread`, its id
// the post's number. A post pointed at in a reply is shown in a box of its
// own by copying it, buttons and all; but a copied button does nothing
// when pressed. So, as on 4chan, the buttons this script made are kept,
// and any other found on a post is put back with one that works.

/** The buttons made here, as against copies of them. */
const fuukaMade = new WeakSet();

/** Whether `element` belongs to `post` itself, not to a post shown in it. */
const fuukaOwn = (post, element) => element.closest("article") === post;

const fuukaThread = (board, thread) => `${location.origin}/${board}/thread/${thread}/`;

/**
 * The address of a post, from the link to it beside its number: so a post
 * of another thread, as in search results, is sent as itself. One made on
 * the archive alone, after its thread left 4chan, is numbered `1234_1`.
 */
function fuukaPost(post) {
  for (const link of post.querySelectorAll("a[data-function='highlight']")) {
    if (!fuukaOwn(post, link)) continue;
    const found = link.href.match(/\/(\w+)\/thread\/(\d+)\/?#(\d+(?:_\d+)?)$/);
    if (found) return { board: found[1], thread: found[2], number: found[3] };
  }
  return null;
}

/**
 * Puts a working button where `place` says, unless `post` has one in
 * `line` already: a copied one is taken away first.
 */
function fuukaPlace(post, line, selector, make, place) {
  const old = [...line.querySelectorAll(selector)].find((button) => fuukaOwn(post, button));
  if (old && fuukaMade.has(old)) return;
  old?.remove();
  const button = make();
  fuukaMade.add(button);
  place(button);
}

function fuukaScan() {
  for (const post of document.querySelectorAll("article.post, article.thread")) {
    const at = fuukaPost(post);
    if (!at) continue;

    // A first post's button, for the thread, goes after its number.
    if (post.classList.contains("thread")) {
      const data = [...post.querySelectorAll(".post_data")].find((data) => fuukaOwn(post, data));
      if (data) {
        const make = () => {
          const button = opalButton(() => fuukaThread(at.board, at.thread), "thread");
          button.classList.add("opalarchive-thread");
          return button;
        };
        fuukaPlace(post, data, ".opalarchive-thread", make, (button) =>
          (data.querySelector("a[data-function='quote']") ?? data.lastElementChild ?? data).after(button),
        );
      }
    }

    // A post's button goes at the end of the line that names its file. A
    // post with no file has nothing to send.
    const file = [...post.querySelectorAll(".post_file")].find((line) => fuukaOwn(post, line));
    if (!file) continue;
    const make = () => opalButton(() => `${fuukaThread(at.board, at.thread)}#${at.number}`);
    fuukaPlace(post, file, ".opalarchive-button:not(.opalarchive-thread)", make, (button) => file.append(button));
  }
}

opalWatch(fuukaScan);
