import { editorState } from "../state/editorState";

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
    toast.className = `toast-item toast-${options.type || "info"}`;

    const textSpan = document.createElement("span");
    textSpan.className = "toast-message";
    textSpan.textContent = options.message;
    toast.appendChild(textSpan);

    if (options.undoAction) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "btn btn-sm btn-outline-primary py-0 px-2";
      undoBtn.textContent = "Undo";
      undoBtn.onclick = () => {
        options.undoAction?.();
        this.dismiss(toast);
      };
      toast.appendChild(undoBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-close btn-close-sm ms-2";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.onclick = () => this.dismiss(toast);
    toast.appendChild(closeBtn);

    this.container?.appendChild(toast);

    const duration = options.durationMs ?? 4000;
    setTimeout(() => {
      this.dismiss(toast);
    }, duration);
  }

  private dismiss(toast: HTMLElement) {
    if (toast.parentElement) {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      toast.style.transition = "all 200ms ease-out";
      setTimeout(() => toast.remove(), 200);
    }
  }
}

export const toast = new ToastManager();
