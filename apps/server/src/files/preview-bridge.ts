/**
 * Selection reporting for the preview frame (DESIGN §17, §24).
 *
 * The frame is sandboxed into an opaque origin, so the app cannot read what is
 * selected inside it — that is the whole point of the sandbox and it is not
 * something to weaken. But the isolation is one-way for *reading* only: a
 * sandboxed document may still `postMessage` out. So a few lines go in with the
 * page, watch for a selection, and post the text.
 *
 * That is all they post. No DOM, no URLs, no page contents — a string the
 * reader has deliberately highlighted, which they are about to quote anyway.
 * The parent treats it as untrusted input regardless: it locates the text in
 * the file it already has, and shows it back before anything is saved.
 */

const SCRIPT = `<script data-picone-bridge>
(function () {
  var last = "";
  var pending = false;
  function report(force) {
    var selection = window.getSelection();
    var text = selection ? String(selection) : "";
    text = text.replace(/\\s+/g, " ").trim();
    if (text === last && !force) return;
    last = text;

    // Where it sits inside this frame. The parent adds the frame's own
    // position; it has no way to look in and work this out for itself.
    //
    // The *first line's* rectangle. A selection spanning several lines has a
    // bounding box starting at the leftmost of them, which is not where the
    // selection began if it began halfway along a line.
    var box = null;
    if (text && selection && selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      var r = range.getClientRects()[0] || range.getBoundingClientRect();
      box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }

    // "*" because the frame has an opaque origin and cannot name the parent's.
    // The parent checks the source window instead, which is not forgeable.
    parent.postMessage({ source: "picone-preview", text: text, box: box }, "*");
  }
  // Pressing dismisses, releasing offers.
  //
  // Down first, and unconditionally: a click on the selected text collapses it,
  // and waiting for the release to notice left the button sitting over a
  // selection that was already gone. Anything that would put it back comes
  // through the release a moment later.
  function clear() {
    if (last === "") return;
    last = "";
    parent.postMessage({ source: "picone-preview", text: "", box: null }, "*");
  }
  //
  // All of these listen in the capture phase. The page is somebody's report and
  // may well handle its own clicks — a chart calling stopPropagation on
  // mousedown is ordinary — and a bubble-phase listener would simply never run.
  // Capture reaches the document on the way down, before the page sees it.
  var CAPTURE = true;
  document.addEventListener("mousedown", clear, CAPTURE);
  document.addEventListener("touchstart", clear, CAPTURE);

  // On release, not on every selectionchange: a drag fires that for each
  // character it crosses, and the action would follow the cursor across the
  // page rather than appearing once, where the selection ended.
  //
  // Read *after* the event, not during it. Pressing inside an existing
  // selection does not collapse it there and then — the browser waits to see
  // whether a drag is starting, and collapses on release, after this handler
  // has run. Reading synchronously saw the old selection still standing and put
  // the button back up, which is exactly what clicking was meant to dismiss.
  function later() {
    setTimeout(report, 0);
  }

  // Scrolling moves the words out from under the button, so the button follows
  // them: the same report, forced past the "nothing has changed" check because
  // the text has not changed — only where it is. One per frame, since a scroll
  // fires far more often than anything needs redrawing.
  function follow() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      report(true);
    });
  }
  document.addEventListener("mouseup", later, CAPTURE);
  document.addEventListener("touchend", later, CAPTURE);
  document.addEventListener("keyup", later, CAPTURE);
  document.addEventListener("scroll", follow, { capture: true, passive: true });
  window.addEventListener("resize", follow);
})();
</script>`;

/**
 * Put the bridge into a page, as late as possible so it never delays the load.
 *
 * Before `</body>` when there is one, appended when there is not — a fragment
 * without a body tag is still a document once the browser has it.
 */
export function withSelectionBridge(html: string): string {
  const close = html.toLowerCase().lastIndexOf("</body>");
  if (close === -1) return html + SCRIPT;
  return `${html.slice(0, close)}${SCRIPT}${html.slice(close)}`;
}
