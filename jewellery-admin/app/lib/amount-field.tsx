import type { MakingChargeType } from "./pricing";
import { normalizeMakingChargeType } from "./pricing";

export type AmountMode = "percent" | "flat" | "per_gram";

const MODE_META: Record<AmountMode, { label: string; title: string }> = {
  percent: { label: "%", title: "Percentage" },
  flat: { label: "₹", title: "Flat price" },
  per_gram: { label: "/g", title: "Per gram" },
};

export function amountModeFromCharge(type?: string | null): AmountMode {
  const normalized = normalizeMakingChargeType(type);
  if (normalized === "percent") return "percent";
  if (normalized === "per_gram") return "per_gram";
  return "flat";
}

export function AmountField({
  value,
  onValueChange,
  mode,
  onModeChange,
  modes = ["percent", "flat", "per_gram"],
  placeholder = "0",
  disabled = false,
}: {
  value: number | string;
  onValueChange: (value: number) => void;
  mode: string;
  onModeChange: (mode: AmountMode) => void;
  modes?: AmountMode[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const current = modes.includes(mode as AmountMode)
    ? (mode as AmountMode)
    : modes[0];

  return (
    <div className={`amount-field${disabled ? " is-disabled" : ""}`}>
      <input
        type="number"
        step="any"
        min="0"
        disabled={disabled}
        placeholder={placeholder}
        value={value === "" || value == null || Number.isNaN(Number(value)) ? "" : value}
        onChange={(event) => onValueChange(Number(event.target.value) || 0)}
      />
      <div className="amount-modes" role="group" aria-label="Value type">
        {modes.map((item) => (
          <button
            key={item}
            type="button"
            className={current === item ? "is-active" : ""}
            title={MODE_META[item].title}
            aria-pressed={current === item}
            disabled={disabled}
            onClick={() => onModeChange(item)}
          >
            {MODE_META[item].label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function makingTypeFromAmountMode(mode: AmountMode): MakingChargeType {
  return mode;
}
