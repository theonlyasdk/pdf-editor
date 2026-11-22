import { X } from "lucide";
import { icon } from "./ui/icon";

export interface ToastOptions {
  message: string;
  durationMs?: number;
  undoAction?: () => void;
  type?: "info" | "success" | "warning" | "error";
}

class ToastManager {
  private container: HTMLElement | null = null;

  init() {
    this.container = document.getElementById("toast-container");
    if (!this.container) {
      this.container = document.createElement("div");
      this.container.id = "toast-container";
      this.container.className = "toast-container";
      document.body.appendChild(this.container);
    }
  }

  show(options: ToastOptions) {
    if (!this.container) this.init();

    const toast = document.createElement("div");
    toast.setAttribute("role", options.type === "error" ? "alert" : "status");
    toast.className = `toast-item toast-${options.type || "info"}`;

    const textSpan = document.createElement("span");
    textSpan.className = "toast-message";
    textSpan.textContent = options.message;
    toast.appendChild(textSpan);

    if (options.undoAction) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "ui-button ui-button--sm ui-button--outline";
      undoBtn.textContent = "Undo";
      undoBtn.onclick = () => {
        options.undoAction?.();
        this.dismiss(toast);
      };
      toast.appendChild(undoBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "ui-button ui-button--tool";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = icon(X);
    closeBtn.onclick = () => this.dismiss(toast);
    toast.appendChild(closeBtn);

    this.container?.appendChild(toast);

    const duration = options.durationMs ?? 4000;
    setTimeout(() => {
      this.dismiss(toast);
    }, duration);
  }

  private dismiss(toast: HTMLElement) {
    if (!toast.isConnected || toast.classList.contains("is-dismissing")) return;
    toast.classList.add("is-dismissing");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      toast.remove();
      return;
    }
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 150);
  }
}

export const toast = new ToastManager();
