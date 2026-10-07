// 4chan: a button beside the file of each post that has one, which sends
// that post, and one beside each thread's first post, which sends the
// whole thread. In a board's catalog, each thread has the thread's button
// on its corner.

/** The board a page is of: the first part of its path. */
const chanBoard = () => location.pathname.split("/")[1];
const chanThread = (thread) => `https://boards.4chan.org/${chanBoard()}/thread/${thread}`;

function chanScan() {
  // Threads and their posts, on a thread's page and on a board's. A thread
  // is `div.thread#t<number>`, and a post in it `div.post#p<number>`.
  for (const thread of document.querySelectorAll(".board > .thread[id^='t']")) {
    const number = thread.id.slice(1);
    if (!/^\d+$/.test(number)) continue;

    // The thread's button goes by the number of its first post.
    const first = thread.querySelector(".post.op .postInfo.desktop, .post.op .postInfo");
    if (first && !first.querySelector(".opalarchive-thread")) {
      const button = opalButton(() => chanThread(number), "thread");
      button.classList.add("opalarchive-thread");
      (first.querySelector(".postNum") ?? first.lastElementChild ?? first).after(button);
    }

    // A post's button goes at the end of the line that names its file.
    for (const post of thread.querySelectorAll(".post[id^='p']")) {
      const file = post.querySelector(".file .fileText");
      // A post with no file, or whose file was deleted, has nothing to send.
      if (!file || file.querySelector(".opalarchive-button")) continue;
      const own = post.id.slice(1);
      file.append(opalButton(() => `${chanThread(number)}#p${own}`));
    }
  }

  // The catalog: each thread is `div.thread#thread-<number>`, a picture
  // with a line or two under it.
  for (const thread of document.querySelectorAll("#threads > .thread[id^='thread-']")) {
    const number = thread.id.slice("thread-".length);
    if (/^\d+$/.test(number)) opalOverButton(thread, () => chanThread(number), "thread");
  }
}

opalWatch(chanScan);
