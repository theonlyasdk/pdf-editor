import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Check, ChevronDown } from "lucide";
import { icon } from "./icon";

type ActiveMenu = {
  select: HTMLSelectElement;
  close: (restoreFocus?: boolean) => void;
};

let activeMenu: ActiveMenu | null = null;
let observerStarted = false;
let labelInterceptorStarted = false;

const triggerMap = new WeakMap<HTMLSelectElement, { trigger: HTMLButtonElement; openMenu: (initialIndex?: number) => void }>();

function resolveLabelSelect(target: EventTarget | null): HTMLSelectElement | null {
  if (!(target instanceof Element)) return null;
  const label = target.closest("label");
  if (!label) return null;
  const forId = label.getAttribute("for");
  if (forId) {
    const el = document.getElementById(forId);
    if (el instanceof HTMLSelectElement && el.dataset.uiSelectUpgraded === "1") {
      return el;
    }
  }
  const nested = label.querySelector<HTMLSelectElement>('select[data-ui-select-upgraded="1"]');
  return nested ?? null;
}

function ensureLabelInterceptor() {
  if (labelInterceptorStarted || typeof document === "undefined") return;
  labelInterceptorStarted = true;
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      const select = resolveLabelSelect(e.target);
      if (!select) return;
      e.preventDefault();
      triggerMap.get(select)?.openMenu();
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      const select = resolveLabelSelect(e.target);
      if (!select) return;
      e.preventDefault();
    },
    true,
  );
}

function getSelectedLabel(select: HTMLSelectElement): string {
  const opt = select.selectedOptions[0] ?? select.options[select.selectedIndex];
  return opt?.textContent?.trim() ?? "";
}

export function upgradeSelect(select: HTMLSelectElement): void {
  if (select.dataset.uiSelectUpgraded === "1") return;
  select.dataset.uiSelectUpgraded = "1";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ui-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (select.id) trigger.setAttribute("data-select-for", select.id);

  const labelSpan = document.createElement("span");
  labelSpan.className = "ui-select-label";

  const chevronSpan = document.createElement("span");
  chevronSpan.className = "ui-select-chevron";
  chevronSpan.innerHTML = icon(ChevronDown, 14);

  trigger.append(labelSpan, chevronSpan);
  select.classList.add("ui-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.insertAdjacentElement("afterend", trigger);

  const sync = () => {
    labelSpan.textContent = getSelectedLabel(select);
    trigger.disabled = select.disabled;
    const ariaLabel = select.getAttribute("aria-label");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
    const labelledBy = select.getAttribute("aria-labelledby");
    if (labelledBy) trigger.setAttribute("aria-labelledby", labelledBy);
  };

  sync();

  const valueProto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (valueProto?.get && valueProto?.set) {
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return valueProto.get!.call(this);
      },
      set(next: string) {
        valueProto.set!.call(this, next);
        sync();
      },
    });
  }

  const disabledProto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "disabled");
  if (disabledProto?.get && disabledProto?.set) {
    Object.defineProperty(select, "disabled", {
      configurable: true,
      get() {
        return disabledProto.get!.call(this);
      },
      set(next: boolean) {
        disabledProto.set!.call(this, next);
        sync();
      },
    });
  }

  select.addEventListener("change", sync);
  select.addEventListener("focus", () => trigger.focus());
  select.addEventListener("mousedown", (e) => e.preventDefault());
  select.addEventListener("click", (e) => {
    e.preventDefault();
    trigger.focus();
  });
  ensureLabelInterceptor();

  const openMenu = (initialIndex?: number) => {
    if (trigger.disabled) return;
    if (activeMenu?.select === select) {
      activeMenu.close(true);
      return;
    }
    activeMenu?.close(false);

    const menu = document.createElement("div");
    menu.className = "ui-select-menu";
    menu.setAttribute("role", "listbox");
    if (select.id) menu.setAttribute("data-select-menu-for", select.id);

    const optionButtons: HTMLButtonElement[] = [];
    const options = Array.from(select.options);

    const listeners = new AbortController();
    const close = (restoreFocus = false) => {
      listeners.abort();
      menu.remove();
      trigger.setAttribute("aria-expanded", "false");
      if (activeMenu?.select === select) activeMenu = null;
      if (restoreFocus && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
    activeMenu = { select, close };

    options.forEach((opt, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ui-select-option";
      item.setAttribute("role", "option");
      const isSelected = idx === select.selectedIndex;
      item.setAttribute("aria-selected", String(isSelected));
      if (isSelected) item.classList.add("is-selected");
      item.disabled = opt.disabled;

      const text = document.createElement("span");
      text.className = "ui-select-option-label";
      text.textContent = opt.textContent ?? "";

      const check = document.createElement("span");
      check.className = "ui-select-check";
      if (isSelected) check.innerHTML = icon(Check, 14);

      item.append(text, check);
      item.addEventListener("click", () => {
        if (opt.disabled) return;
        const changed = select.selectedIndex !== idx;
        select.selectedIndex = idx;
        sync();
        close(true);
        if (changed) {
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      optionButtons.push(item);
      menu.appendChild(item);
    });

    const host = select.closest("dialog") ?? document.body;
    host.appendChild(menu);
    trigger.setAttribute("aria-expanded", "true");

    const positionMenu = () => {
      if (!trigger.isConnected || !menu.isConnected) {
        close(false);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      menu.style.minWidth = `${Math.max(120, Math.round(rect.width))}px`;
      void computePosition(trigger, menu, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (!menu.isConnected) return;
        menu.style.left = `${Math.round(x)}px`;
        menu.style.top = `${Math.round(y)}px`;
      });
    };
    positionMenu();

    const enabledButtons = optionButtons.filter((b) => !b.disabled);
    const targetBtn =
      typeof initialIndex === "number"
        ? optionButtons[Math.max(0, Math.min(optionButtons.length - 1, initialIndex))]
        : optionButtons[select.selectedIndex] ?? enabledButtons[0];
    (targetBtn && !targetBtn.disabled ? targetBtn : enabledButtons[0])?.focus();

    menu.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(true);
          return;
        }
        if (e.key === "Tab") {
          close(false);
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          if (!enabledButtons.length) return;
          const current = enabledButtons.indexOf(document.activeElement as HTMLButtonElement);
          let nextIdx = 0;
          if (e.key === "Home") nextIdx = 0;
          else if (e.key === "End") nextIdx = enabledButtons.length - 1;
          else if (e.key === "ArrowDown") nextIdx = (current + 1) % enabledButtons.length;
          else nextIdx = (current - 1 + enabledButtons.length) % enabledButtons.length;
          enabledButtons[nextIdx]?.focus();
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const match = enabledButtons.find((b) =>
            (b.textContent ?? "").trim().toLowerCase().startsWith(ch)
          );
          match?.focus();
        }
      },
      { signal: listeners.signal }
    );

    window.addEventListener(
      "pointerdown",
      (e) => {
        const target = e.target as Node | null;
        if (target && (menu.contains(target) || trigger.contains(target) || resolveLabelSelect(target) === select)) return;
        close(false);
      },
      { signal: listeners.signal, capture: true }
    );
    window.addEventListener("resize", () => positionMenu(), { signal: listeners.signal });
    window.addEventListener(
      "scroll",
      (e) => {
        if (e.target instanceof Node && menu.contains(e.target)) return;
        close(false);
      },
      { signal: listeners.signal, capture: true }
    );
    window.addEventListener("blur", () => close(false), { signal: listeners.signal });
  };

  triggerMap.set(select, { trigger, openMenu });

  trigger.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    openMenu();
  });
  trigger.addEventListener("click", (e) => {
    if (e.detail === 0) openMenu();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      openMenu(Math.min(select.options.length - 1, Math.max(0, select.selectedIndex)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(Math.max(0, select.selectedIndex));
    }
  });
}

export function upgradeSelects(root: ParentNode = document): void {
  if (activeMenu && !activeMenu.select.isConnected) {
    activeMenu.close(false);
  }
  const selects = root.querySelectorAll<HTMLSelectElement>("select.ui-input");
  for (const select of selects) {
    upgradeSelect(select);
  }
}

export function initCustomSelects(): void {
  upgradeSelects(document.body);
  if (observerStarted || typeof MutationObserver === "undefined") return;
  observerStarted = true;
  const observer = new MutationObserver(() => {
    upgradeSelects(document.body);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
