import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

// Catches errors thrown while rendering its children, so one broken view shows a message
// instead of blanking the whole app. "Reload this view" remounts the children (fresh state).
// A lazily loaded tab whose file is gone (the app was updated while this page stayed open)
// ends up here as well: only reloading the page helps then.
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|module script|Loading chunk|preload CSS/i;

export default class ErrorBoundary extends Component<
  { label?: string; children: ReactNode }, { error: unknown; failed: boolean; n: number }> {
  state = { error: null as unknown, failed: false, n: 0 };

  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[mstar_post] ${this.props.label ?? "view"} failed to render:`, error, info.componentStack);
  }

  render() {
    const { error, failed, n } = this.state;
    if (!failed) return <Fragment key={n}>{this.props.children}</Fragment>;
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (CHUNK_ERROR.test(msg)) {
      return (
        <div className="error" role="alert">
          <b>{this.props.label ?? "This view"} could not be loaded.</b>{"\n"}
          The app on the server was probably updated while this page was open (or the connection dropped).
          Reload the page to get the current version.{"\n"}
          <button className="primary" onClick={() => window.location.reload()}>Reload the page</button>
          {" "}<span className="muted small">{msg}</span>
        </div>
      );
    }
    return (
      <div className="error" role="alert">
        <b>{this.props.label ?? "This view"} could not be displayed.</b>{"\n"}{msg}{"\n"}
        <button onClick={() => this.setState({ error: null, failed: false, n: n + 1 })}>Reload this view</button>
        {" "}<span className="muted small">details are in the browser console</span>
      </div>
    );
  }
}
