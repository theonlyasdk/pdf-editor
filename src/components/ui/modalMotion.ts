/**
 * Smoothly interpolates a dialog or card's width and height when its content changes.
 */
export function animateDialogSize(target: HTMLElement, mutate: () => void): void {
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reducedMotion || typeof target.animate !== "function") {
    mutate();
    return;
  }

  const from = target.getBoundingClientRect();
  mutate();
  const to = target.getBoundingClientRect();

  if (
    from.width <= 0 ||
    from.height <= 0 ||
    (Math.abs(to.width - from.width) <= 1 && Math.abs(to.height - from.height) <= 1)
  ) {
    return;
  }

  target.getAnimations().forEach((anim) => {
    if ((anim as Animation & { id?: string }).id === "dialog-size-lerp") {
      anim.cancel();
    }
  });

  const anim = target.animate(
    [
      { width: `${from.width}px`, height: `${from.height}px` },
      { width: `${to.width}px`, height: `${to.height}px` },
    ],
    {
      id: "dialog-size-lerp",
      duration: 220,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );
  anim.onfinish = () => {
    /* Web Animations API automatically releases animated properties after finish */
  };
}

/**
 * Adds a sliding pill indicator behind the active tab inside a tablist.
 */
export function initSlidingTabs(
  tablist: HTMLElement,
  buttonSelector = '[role="tab"]',
): { update: (instant?: boolean) => void } {
  tablist.classList.add("has-sliding-indicator");
  let indicator = tablist.querySelector<HTMLElement>(":scope > .sliding-tab-indicator");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "sliding-tab-indicator";
    indicator.setAttribute("aria-hidden", "true");
    tablist.prepend(indicator);
  }

  const update = (instant = false) => {
    const active = tablist.querySelector<HTMLElement>(`${buttonSelector}[aria-selected="true"], ${buttonSelector}.active`);
    if (!active || !indicator) return;
    const x = active.offsetLeft;
    const y = active.offsetTop;
    const w = active.offsetWidth;
    const h = active.offsetHeight;
    if (w <= 0 || h <= 0) return;

    if (instant) {
      indicator.style.transition = "none";
    } else {
      indicator.style.transition = "";
    }
    indicator.style.width = `${w}px`;
    indicator.style.height = `${h}px`;
    indicator.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (instant) {
      void indicator.offsetWidth;
      indicator.style.transition = "";
    }
  };

  requestAnimationFrame(() => update(true));
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => update(true));
    ro.observe(tablist);
  }
  return { update };
}

export interface EditableSliderOptions {
  unit?: string;
  scale?: number;
  decimals?: number;
  onCommit: (sliderValue: number) => void;
}

/**
 * Turns a slider's value readout into a click-to-edit numeric input (similar to the zoom readout).
 */
export function bindEditableSliderValue(
  valueEl: HTMLElement | null,
  slider: HTMLInputElement | null,
  opts: EditableSliderOptions,
): void {
  if (!valueEl || !slider) return;
  const scale = opts.scale ?? 1;
  const unit = opts.unit ?? "";
  const decimals = opts.decimals ?? 0;

  valueEl.classList.add("slider-value-editable");
  valueEl.title = "Click to enter exact value";
  valueEl.tabIndex = 0;
  valueEl.setAttribute("role", "button");

  const startEdit = () => {
    if (valueEl.querySelector("input")) return;
    const minSlider = Number(slider.min || 0);
    const maxSlider = Number(slider.max || 100);
    const curSlider = Number(slider.value);
    const curDisplay = Number((curSlider * scale).toFixed(decimals));

    const input = document.createElement("input");
    input.type = "number";
    input.className = "ui-input slider-value-input tabular-nums";
    input.min = String(Number((minSlider * scale).toFixed(decimals)));
    input.max = String(Number((maxSlider * scale).toFixed(decimals)));
    input.step = "any";
    input.value = String(curDisplay);

    const prevText = valueEl.textContent ?? "";
    valueEl.textContent = "";
    valueEl.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const parsed = Number(input.value);
      if (commit && Number.isFinite(parsed)) {
        const clamped = Math.max(minSlider, Math.min(maxSlider, parsed / scale));
        slider.value = String(clamped);
        valueEl.textContent = `${Number((clamped * scale).toFixed(decimals))}${unit}`;
        opts.onCommit(clamped);
      } else {
        valueEl.textContent = prevText;
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  };

  valueEl.addEventListener("click", startEdit);
  valueEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      startEdit();
    }
  });
}
