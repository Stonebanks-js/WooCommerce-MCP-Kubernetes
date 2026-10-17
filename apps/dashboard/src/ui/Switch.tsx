interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  busy?: boolean;
}

/** Accessible toggle; the label is for assistive tech, the visual state is the track. */
export function Switch({ checked, onChange, disabled = false, label, busy = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      className={`switch${checked ? ' is-on' : ''}${busy ? ' is-busy' : ''}`}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}
