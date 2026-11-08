export type SentinelState = "idle" | "loading" | "error" | "done" | "manual";

const SPINNER_ID = "is-spinner-style";

export class Sentinel {
  readonly element: HTMLElement;
  private _state: SentinelState = "idle";
  private _onRetry: (() => void) | undefined;
  private _manualUrl: string | null = null;

  constructor(container: Element, before?: Element) {
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
    // Prefer a spot directly beneath the streamed results (before the
    // pager anchor) so the spinner appears where new results arrive;
    // fall back to after the container. Native-delegation engines always
    // use the latter: they must never have a foreign node inside their
    // framework-owned results list.
    if (before && before.parentNode === container) {
      container.insertBefore(this.element, before);
    } else if (container.parentNode) {
      container.after(this.element);
    } else {
      // ChildNode.after() is a SILENT no-op on a detached node. The sentinel
      // would exist but never intersect, so auto-loading would look alive
      // and do nothing. Anchor to the live document instead.
      (container.ownerDocument?.body ?? document.body).appendChild(this.element);
    }
    this.injectSpinnerStyle();
    this.setState("idle");
  }

  setState(state: SentinelState, onRetry?: () => void): void {
    this._state = state;
    if (onRetry) this._onRetry = onRetry;
    this.render();
  }

  /**
   * Fail-open escape hatch: a real, engine-owned URL the user can click when
   * automatic loading has stopped for ANY reason. Rendered on every terminal
   * state, so a bot gate, a rotated class name or a page limit can never
   * leave the user with no way to reach page N+1.
   */
  setManualFallback(url: string | null): void {
    this._manualUrl = safeHttpUrl(url);
    this.render();
  }

  get manualUrl(): string | null {
    return this._manualUrl;
  }

  remove(): void {
    this.element.remove();
  }

  // Built with DOM APIs, never innerHTML: the sentinel is injected into a
  // page we do not own and must not be a markup-injection surface.
  private render(): void {
    this.element.replaceChildren();

    switch (this._state) {
      case "loading": {
        const label = this.line("Loading more results...");
        label.style.marginBottom = "0.5rem";
        const spinner = document.createElement("div");
        spinner.style.cssText =
          "width:24px;height:24px;border:2px solid #e8eaed;" +
          "border-top-color:#4285f4;border-radius:50%;" +
          "animation:is-spin 0.8s linear infinite;";
        this.element.append(label, spinner);
        this.element.style.opacity = "1";
        break;
      }

      case "error": {
        const label = this.line(
          "Auto-loading stopped. You can still open the next page below."
        );
        label.style.color = "#d93025";
        label.style.marginBottom = "0.5rem";
        const retry = document.createElement("button");
        retry.id = "is-retry-btn";
        retry.textContent = "Try Again";
        retry.style.cssText =
          "background:#4285f4;color:white;border:none;padding:0.6rem 1.2rem;" +
          "border-radius:4px;cursor:pointer;font-size:0.875rem;font-weight:500;" +
          "box-shadow:0 1px 2px rgba(0,0,0,0.1);";
        retry.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          e.preventDefault();
          this._onRetry?.();
        });
        this.element.append(label, retry);
        this.element.style.opacity = "1";
        break;
      }

      case "done":
        this.element.append(
          this.line(this._manualUrl ? "Auto-loading stopped." : "End of results.", 0.7)
        );
        this.element.style.opacity = "1";
        break;

      case "manual":
        // The engine already paginates itself (or auto-loading never
        // started). We offer navigation only, and stay out of its DOM.
        if (this._manualUrl) {
          this.element.append(this.line("More results are on the next page.", 0.7));
        }
        this.element.style.opacity = this._manualUrl ? "1" : "0";
        break;

      default:
        this.element.style.opacity = "0";
    }

    if (
      this._manualUrl &&
      (this._state === "error" || this._state === "done" || this._state === "manual")
    ) {
      const link = document.createElement("a");
      link.id = "is-manual-next";
      // Setting .href (not an HTML attribute) plus safeHttpUrl() guarantees
      // only absolute http(s) URLs can ever become a clickable link.
      link.href = this._manualUrl;
      link.textContent = "Open next page →";
      link.rel = "noopener noreferrer";
      link.style.cssText =
        "display:inline-block;margin-top:0.75rem;color:#4285f4;" +
        "text-decoration:none;font-size:0.875rem;padding:0.35rem 0.75rem;" +
        "border:1px solid currentColor;border-radius:4px;";
      this.element.appendChild(link);
    }
  }

  private line(text: string, opacity?: number): HTMLElement {
    const div = document.createElement("div");
    div.textContent = text;
    if (opacity !== undefined) div.style.opacity = String(opacity);
    return div;
  }

  private injectSpinnerStyle(): void {
    if (document.getElementById(SPINNER_ID)) return;
    const style = document.createElement("style");
    style.id = SPINNER_ID;
    style.textContent = `@keyframes is-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

/** Only absolute http(s) URLs may become a link. */
function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.href);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
