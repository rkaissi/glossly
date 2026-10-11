/** The second step of a control that destroys a saved record. */
export function InlineConfirm({
  prompt,
  confirm,
  busy,
  onConfirm,
  onCancel,
}: {
  prompt: string;
  confirm: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span className="confirm inline">
      <span>{prompt}</span>
      <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
        {confirm}
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}
