/**
 * select.ts — Accessible custom select (listbox) for Hiroba chrome.
 *
 * Native <select> cannot style its open popup; these panels need the list to
 * match the warm paper UI. Same surface API as a select for callers:
 *   get/set value, setOptions(), onChange callback.
 *
 * Keyboard: Enter/Space/ArrowDown open; arrows move; Enter commits; Escape
 * closes. Only one instance is open at a time.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SelectOption = {
  value: string;
  label: string;
};

export type CustomSelectOpts = {
  /** Initial options (may be empty; call setOptions later). */
  options?: SelectOption[];
  /** Initial value; defaults to first option or "". */
  value?: string;
  /** Fires when the user commits a new value (not on setOptions / programmatic set). */
  onChange?: (value: string) => void;
  /** Accessible name when no external <label> is wired. */
  ariaLabel?: string;
};

// ---------------------------------------------------------------------------
// Module state — at most one open list
// ---------------------------------------------------------------------------

let openSelect: CustomSelect | null = null;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class CustomSelect {
  readonly root: HTMLElement;

  private readonly trigger: HTMLButtonElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly list: HTMLUListElement;
  private readonly onChange?: (value: string) => void;

  private options: SelectOption[] = [];
  private _value = "";
  /** Index of the keyboard/hover highlight while open; -1 when closed. */
  private activeIndex = -1;
  private open = false;

  constructor(host: HTMLElement, opts: CustomSelectOpts = {}) {
    this.root = host;
    this.onChange = opts.onChange;

    host.classList.add("cselect");
    host.replaceChildren();

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "cselect-trigger";
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");
    if (opts.ariaLabel) this.trigger.setAttribute("aria-label", opts.ariaLabel);

    this.labelEl = document.createElement("span");
    this.labelEl.className = "cselect-label";

    const chevron = document.createElement("span");
    chevron.className = "cselect-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';

    this.trigger.append(this.labelEl, chevron);

    this.list = document.createElement("ul");
    this.list.className = "cselect-list";
    this.list.setAttribute("role", "listbox");
    this.list.hidden = true;
    if (host.id) this.list.id = `${host.id}-list`;
    this.trigger.setAttribute("aria-controls", this.list.id || "");

    host.append(this.trigger, this.list);

    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.open) this.close();
      else this.show();
    });
    this.trigger.addEventListener("keydown", (e) => this._onTriggerKey(e));
    this.list.addEventListener("keydown", (e) => this._onListKey(e));
    // Capture so a click on an option isn't swallowed by an overlay "click outside" handler
    // that listens on the same bubble phase after the option is removed from the open set.
    this.list.addEventListener("click", (e) => this._onListClick(e));

    document.addEventListener("click", this._onDocClick);
    document.addEventListener("keydown", this._onDocKey);

    if (opts.options) this.setOptions(opts.options, opts.value);
    else if (opts.value !== undefined) {
      this._value = opts.value;
      this._syncLabel();
    } else {
      this._syncLabel();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get value(): string {
    return this._value;
  }

  /** Programmatic value change — does not fire onChange. */
  set value(next: string) {
    if (this._value === next) return;
    this._value = next;
    this._syncLabel();
    this._syncSelectedAttrs();
  }

  setOptions(options: SelectOption[], selected?: string): void {
    this.options = options.slice();
    if (selected !== undefined) {
      this._value = selected;
    } else if (!this.options.some((o) => o.value === this._value)) {
      this._value = this.options[0]?.value ?? "";
    }
    this._renderOptions();
    this._syncLabel();
    if (this.open) {
      this.activeIndex = Math.max(0, this._indexOfValue(this._value));
      this._syncActive();
    }
  }

  setDisabled(disabled: boolean): void {
    this.trigger.disabled = disabled;
    if (disabled) this.close();
  }

  show(): void {
    if (this.open || this.trigger.disabled || this.options.length === 0) return;
    if (openSelect && openSelect !== this) openSelect.close();
    openSelect = this;
    this.open = true;
    this.trigger.setAttribute("aria-expanded", "true");
    this.list.hidden = false;
    this.root.classList.add("is-open");
    this.activeIndex = Math.max(0, this._indexOfValue(this._value));
    this._syncActive();
    // Focus the list so arrow keys work immediately; trigger stays expanded for a11y.
    this.list.focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    if (openSelect === this) openSelect = null;
    this.trigger.setAttribute("aria-expanded", "false");
    this.list.hidden = true;
    this.root.classList.remove("is-open");
    this.activeIndex = -1;
    this._clearActive();
  }

  /** Tear down document listeners if the host is ever removed. */
  destroy(): void {
    this.close();
    document.removeEventListener("click", this._onDocClick);
    document.removeEventListener("keydown", this._onDocKey);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private _renderOptions(): void {
    this.list.replaceChildren();
    const baseId = this.root.id || "cselect";
    this.options.forEach((opt, i) => {
      const li = document.createElement("li");
      li.className = "cselect-option";
      li.setAttribute("role", "option");
      li.id = `${baseId}-opt-${i}`;
      li.dataset.value = opt.value;
      li.setAttribute("aria-selected", opt.value === this._value ? "true" : "false");
      li.tabIndex = -1;

      const text = document.createElement("span");
      text.className = "cselect-option-label";
      text.textContent = opt.label;

      const check = document.createElement("span");
      check.className = "cselect-check";
      check.setAttribute("aria-hidden", "true");
      check.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>';

      li.append(text, check);
      this.list.appendChild(li);
    });
    // listbox needs a tabindex to receive focus for keyboard nav
    this.list.tabIndex = -1;
  }

  private _syncLabel(): void {
    const match = this.options.find((o) => o.value === this._value);
    this.labelEl.textContent = match?.label ?? "";
  }

  private _syncSelectedAttrs(): void {
    const items = this.list.querySelectorAll<HTMLElement>('[role="option"]');
    items.forEach((el) => {
      el.setAttribute("aria-selected", el.dataset.value === this._value ? "true" : "false");
    });
  }

  private _indexOfValue(value: string): number {
    return this.options.findIndex((o) => o.value === value);
  }

  private _syncActive(): void {
    const items = this.list.querySelectorAll<HTMLElement>('[role="option"]');
    items.forEach((el, i) => {
      el.classList.toggle("is-active", i === this.activeIndex);
    });
    const active = items[this.activeIndex];
    if (active) {
      this.list.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else {
      this.list.removeAttribute("aria-activedescendant");
    }
  }

  private _clearActive(): void {
    this.list.querySelectorAll(".is-active").forEach((el) => el.classList.remove("is-active"));
    this.list.removeAttribute("aria-activedescendant");
  }

  private _commitIndex(index: number): void {
    const opt = this.options[index];
    if (!opt) return;
    const prev = this._value;
    this._value = opt.value;
    this._syncLabel();
    this._syncSelectedAttrs();
    this.close();
    this.trigger.focus();
    if (opt.value !== prev) this.onChange?.(opt.value);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private _onListClick(e: MouseEvent): void {
    const option = (e.target as HTMLElement | null)?.closest<HTMLElement>('[role="option"]');
    if (!option || !this.list.contains(option)) return;
    e.stopPropagation();
    const index = this._indexOfValue(option.dataset.value ?? "");
    if (index >= 0) this._commitIndex(index);
  }

  private _onTriggerKey(e: KeyboardEvent): void {
    if (this.trigger.disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        e.preventDefault();
        if (!this.open) this.show();
        break;
      case "Escape":
        if (this.open) {
          e.preventDefault();
          this.close();
        }
        break;
    }
  }

  private _onListKey(e: KeyboardEvent): void {
    if (!this.open) return;
    const last = this.options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.activeIndex = this.activeIndex >= last ? 0 : this.activeIndex + 1;
        this._syncActive();
        break;
      case "ArrowUp":
        e.preventDefault();
        this.activeIndex = this.activeIndex <= 0 ? last : this.activeIndex - 1;
        this._syncActive();
        break;
      case "Home":
        e.preventDefault();
        this.activeIndex = 0;
        this._syncActive();
        break;
      case "End":
        e.preventDefault();
        this.activeIndex = last;
        this._syncActive();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        this._commitIndex(this.activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.trigger.focus();
        break;
      case "Tab":
        this.close();
        break;
    }
  }

  private _onDocClick = (e: MouseEvent): void => {
    if (!this.open) return;
    if (this.root.contains(e.target as Node)) return;
    this.close();
  };

  private _onDocKey = (e: KeyboardEvent): void => {
    // Escape while focus is outside the list still closes (e.g. after a re-render).
    if (e.key === "Escape" && this.open) {
      this.close();
      this.trigger.focus();
    }
  };
}
