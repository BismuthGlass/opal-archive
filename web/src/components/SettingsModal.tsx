import Modal from "./Modal";

/** Application settings. There are none yet; this is where they will go. */
export default function SettingsModal(props: { onClose: () => void }) {
  return (
    <Modal title="Settings" onClose={props.onClose}>
      <p class="hint">There are no settings yet.</p>
    </Modal>
  );
}
