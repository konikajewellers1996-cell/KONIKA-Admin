import { useMemo, useState } from "react";

export type PickerItem = {
  id: string;
  label: string;
};

export function SearchChipPicker({
  items,
  selected,
  onChange,
  name,
  placeholder = "Search to add…",
  disabled = false,
  lockedIds = [],
  hint,
}: {
  items: PickerItem[];
  selected: PickerItem[];
  onChange: (next: PickerItem[]) => void;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  lockedIds?: string[];
  hint?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selectedIds = new Set(selected.map((item) => item.id));
  const locked = new Set(lockedIds);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = items.filter((item) => !selectedIds.has(item.id));
    if (!q) return available.slice(0, 8);
    return available
      .filter((item) => item.label.toLowerCase().includes(q))
      .slice(0, 12);
  }, [items, query, selected]);

  const addItem = (item: PickerItem) => {
    if (disabled || selectedIds.has(item.id)) return;
    onChange([...selected, item]);
    setQuery("");
  };

  const removeItem = (id: string) => {
    if (disabled || locked.has(id)) return;
    onChange(selected.filter((item) => item.id !== id));
  };

  return (
    <div className={`chip-picker${disabled ? " is-disabled" : ""}`}>
      {name
        ? selected.map((item) => (
            <input key={item.id} type="hidden" name={name} value={item.id} />
          ))
        : null}
      <input
        type="search"
        className="chip-picker-search"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 160);
        }}
        autoComplete="off"
      />
      {!disabled && open ? (
        <div className="chip-picker-results" role="listbox">
          {matches.length ? (
            matches.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip-picker-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addItem(item)}
              >
                {item.label}
              </button>
            ))
          ) : (
            <div className="chip-picker-empty">
              {query.trim() ? "No matches" : "Type to search"}
            </div>
          )}
        </div>
      ) : null}
      {hint ? <div className="hint">{hint}</div> : null}
      {selected.length ? (
        <div className="chip-list">
          {selected.map((item) => (
            <span key={item.id} className={`pick-chip${locked.has(item.id) ? " is-locked" : ""}`}>
              {item.label}
              {!locked.has(item.id) ? (
                <button
                  type="button"
                  className="pick-chip-remove"
                  onClick={() => removeItem(item.id)}
                  aria-label={`Remove ${item.label}`}
                  disabled={disabled}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
