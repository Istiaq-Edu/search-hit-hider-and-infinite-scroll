export type SentinelState = "idle" | "loading" | "error" | "done";

const SPINNER_ID = "is-spinner-style";

export class Sentinel {
  readonly element: HTMLElement;
  private _state: SentinelState = "idle";

  constructor(container: Element) {
    this.element = document.createElement("div");
    this.element.id = "is-sentinel";
    this.element.style.cssText = `
      min-height: 1px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: Google Sans, Roboto, Arial, sans-serif;
      color: #70757a;
      font-size: 0.875rem;
      margin: 2rem 0;
      transition: opacity 0.3s ease;
    `;
    container.after(this.element);
    this.injectSpinnerStyle();
    this.setState("idle");
  }

  setState(state: SentinelState, onRetry?: () => void): void {
    this._state = state;
    switch (state) {
      case "loading":
        this.element.innerHTML = `
          <div style="margin-bottom: 0.5rem;">Loading more results...</div>
          <div style="width: 24px; height: 24px; border: 2px solid #e8eaed; border-top-color: #4285f4; border-radius: 50%; animation: is-spin 0.8s linear infinite;"></div>
        `;
        this.element.style.opacity = "1";
        break;

      case "error":
        this.element.innerHTML = `
          <div style="color: #d93025; margin-bottom: 0.5rem;">Connection lost or blocked.</div>
          <button id="is-retry-btn" style="background: #4285f4; color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">Try Again</button>
        `;
        if (onRetry) {
          this.element.querySelector("#is-retry-btn")?.addEventListener("click", (e) => {
            e.preventDefault();
            onRetry();
          });
        }
        this.element.style.opacity = "1";
        break;

      case "done":
        this.element.innerHTML = '<div style="opacity: 0.7;">End of results.</div>';
        this.element.style.opacity = "1";
        break;

      default:
        this.element.innerHTML = "";
        this.element.style.opacity = "0";
    }
  }

  remove(): void {
    this.element.remove();
  }

  private injectSpinnerStyle(): void {
    if (document.getElementById(SPINNER_ID)) return;
    const style = document.createElement("style");
    style.id = SPINNER_ID;
    style.textContent = `@keyframes is-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}
