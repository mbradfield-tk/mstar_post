import { useState } from "react";
import { login } from "./user";

// Password login with a server account (works only when the auth helper is installed).
export default function LoginDialog({ onClose, passwordLogin, reason }: {
  onClose: () => void; passwordLogin: boolean; reason?: string | null;
}) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!user.trim() || !pw) return;
    setBusy(true);
    setError(null);
    try {
      await login(user.trim(), pw);
      onClose();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
           onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h3>Log in</h3>
        {reason && <div className="small muted">{reason}</div>}
        <p className="small">Guests can view everything. To select cases, run calculations, edit projects or browse
          files, log in with your <b>server account</b> (the one you use for SSH).</p>
        {passwordLogin ? (
          <form className="login-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label>User name<input autoFocus autoComplete="username" value={user}
                                    onChange={(e) => setUser(e.target.value)} /></label>
            <label>Password<input type="password" autoComplete="current-password" value={pw}
                                   onChange={(e) => setPw(e.target.value)} /></label>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="submit" className="primary" disabled={busy || !user.trim() || !pw}>{busy ? "Checking..." : "Log in"}</button>
            </div>
          </form>
        ) : (
          <>
            <p className="small">Password login is not set up on this server. Open the app through an SSH tunnel with your
              account instead; you are then logged in automatically:</p>
            <pre className="log small">ssh -N -L 5045:localhost:5045 &lt;you&gt;@{location.hostname}{"\n"}then open http://localhost:5045</pre>
            <div className="modal-actions"><button onClick={onClose}>Close</button></div>
          </>
        )}
      </div>
    </div>
  );
}
