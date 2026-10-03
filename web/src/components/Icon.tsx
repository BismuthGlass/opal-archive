import { createMemo } from "solid-js";

// Icons from Material Symbols Light (Google, Apache 2.0), taken from
// https://icon-sets.iconify.design/material-symbols-light/. Each entry is
// the inside of a 24 × 24 SVG. To add one, copy its body from
// https://api.iconify.design/material-symbols-light.json?icons=<name>.
const ICONS = {
  "add":
    "<path fill=\"currentColor\" d=\"M11.5 12.5H6v-1h5.5V6h1v5.5H18v1h-5.5V18h-1z\"/>",
  "chevron-left":
    "<path fill=\"currentColor\" d=\"M14 17.308L8.692 12L14 6.692l.708.708l-4.6 4.6l4.6 4.6z\"/>",
  "chevron-right":
    "<path fill=\"currentColor\" d=\"m13.292 12l-4.6-4.6l.708-.708L14.708 12L9.4 17.308l-.708-.708z\"/>",
  "close":
    "<path fill=\"currentColor\" d=\"m6.4 18.308l-.708-.708l5.6-5.6l-5.6-5.6l.708-.708l5.6 5.6l5.6-5.6l.708.708l-5.6 5.6l5.6 5.6l-.708.708l-5.6-5.6z\"/>",
  "create-new-folder-outline":
    "<path fill=\"currentColor\" d=\"M14.5 15.5h1v-2h2v-1h-2v-2h-1v2h-2v1h2zM4.616 19q-.691 0-1.153-.462T3 17.384V6.616q0-.691.463-1.153T4.615 5h4.981l2 2h7.789q.69 0 1.153.463T21 8.616v8.769q0 .69-.462 1.153T19.385 19zm0-1h14.769q.269 0 .442-.173t.173-.442v-8.77q0-.269-.173-.442T19.385 8h-8.19l-2-2h-4.58q-.269 0-.442.173T4 6.616v10.769q0 .269.173.442t.443.173M4 18V6z\"/>",
  "delete-outline":
    "<path fill=\"currentColor\" d=\"M7.616 20q-.672 0-1.144-.472T6 18.385V6H5V5h4v-.77h6V5h4v1h-1v12.385q0 .69-.462 1.153T16.384 20zM17 6H7v12.385q0 .269.173.442t.443.173h8.769q.23 0 .423-.192t.192-.424zM9.808 17h1V8h-1zm3.384 0h1V8h-1zM7 6v13z\"/>",
  "download":
    "<path fill=\"currentColor\" d=\"m12 15.577l-3.539-3.538l.708-.72L11.5 13.65V5h1v8.65l2.33-2.33l.709.719zM6.616 19q-.691 0-1.153-.462T5 17.384v-2.423h1v2.423q0 .231.192.424t.423.192h10.77q.23 0 .423-.192t.192-.424v-2.423h1v2.423q0 .691-.462 1.153T17.384 19z\"/>",
  "left-panel-close-outline":
    "<path fill=\"currentColor\" d=\"M15.596 15.173V8.827L12.404 12zM5.616 20q-.672 0-1.144-.472T4 18.385V5.615q0-.67.472-1.143Q4.944 4 5.616 4h12.769q.67 0 1.143.472q.472.472.472 1.144v12.769q0 .67-.472 1.143q-.472.472-1.143.472zM8 19V5H5.616q-.231 0-.424.192T5 5.616v12.769q0 .23.192.423t.423.192zm1 0h9.385q.23 0 .423-.192t.192-.424V5.616q0-.231-.192-.424T18.384 5H9zm-1 0H5z\"/>",
  "left-panel-open-outline":
    "<path fill=\"currentColor\" d=\"M12.404 8.827v6.346L15.596 12zM5.616 20q-.672 0-1.144-.472T4 18.385V5.615q0-.67.472-1.143Q4.944 4 5.616 4h12.769q.67 0 1.143.472q.472.472.472 1.144v12.769q0 .67-.472 1.143q-.472.472-1.143.472zM8 19V5H5.616q-.231 0-.424.192T5 5.616v12.769q0 .23.192.423t.423.192zm1 0h9.385q.23 0 .423-.192t.192-.424V5.616q0-.231-.192-.424T18.384 5H9zm-1 0H5z\"/>",
  "star":
    "<path fill=\"currentColor\" d=\"m7.325 18.923l1.24-5.313l-4.123-3.572l5.431-.47L12 4.557l2.127 5.01l5.43.47l-4.123 3.572l1.241 5.313L12 16.102z\"/>",
  "star-outline":
    "<path fill=\"currentColor\" d=\"m8.85 16.825l3.15-1.9l3.15 1.925l-.825-3.6l2.775-2.4l-3.65-.325l-1.45-3.4l-1.45 3.375l-3.65.325l2.775 2.425zm-1.525 2.098l1.24-5.313l-4.123-3.572l5.431-.47L12 4.557l2.127 5.01l5.43.47l-4.123 3.572l1.241 5.313L12 16.102zM12 12.25\"/>",
  "upload":
    "<path fill=\"currentColor\" d=\"M11.5 15.577v-8.65l-2.33 2.33l-.708-.718L12 5l3.539 3.539l-.708.719L12.5 6.927v8.65zM6.616 19q-.691 0-1.153-.462T5 17.384v-2.423h1v2.423q0 .231.192.424t.423.192h10.77q.23 0 .423-.192t.192-.424v-2.423h1v2.423q0 .691-.462 1.153T17.384 19z\"/>",
} as const;

export type IconName = keyof typeof ICONS;

/** Decorative: give the button or link around it a label. */
export default function Icon(props: { name: IconName }) {
  // A memo, so the drawing is only replaced when the icon really changes.
  // Replacing it under the pointer mid-click would swallow the click.
  const body = createMemo(() => ICONS[props.name]);
  return <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" innerHTML={body()} />;
}
