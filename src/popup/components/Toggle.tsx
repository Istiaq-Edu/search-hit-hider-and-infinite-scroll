// ============================================================
// Shared settings toggle — a real switch for a11y.
// The old copies of this component were plain <div onClick>: invisible to
// screen readers and impossible to operate with a keyboard. This version
// exposes role="switch" + aria-checked + Enter/Space activation.
// ============================================================

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: () => void;
}

export function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <div
      role="switch"
      tabIndex={0}
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChange();
        }
      }}
      style={{
        width: "34px",
        height: "18px",
        background: checked ? "var(--accent)" : "var(--bg-3)",
        borderRadius: "9px",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.2s",
        border: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute",
        top: "2px",
        left: checked ? "16px" : "2px",
        width: "12px",
        height: "12px",
        background: "#fff",
        borderRadius: "50%",
        transition: "left 0.2s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }} />
    </div>
  );
}
