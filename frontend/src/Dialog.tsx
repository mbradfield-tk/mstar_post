import { useState } from "react";

type Ask = { title: string; body?: React.ReactNode; ok?: string; danger?: boolean; input?: string };
type Pending = Ask & { resolve: (v: string | null) => void };

// In-app replacement for window.confirm / window.prompt: render `dialog`, await confirm() or prompt().
export function useDialog() {
  const [req, setReq] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const open = (a: Ask) => new Promise<string | null>((resolve) => { setValue(a.input ?? ""); setReq({ ...a, resolve }); });
  const close = (v: string | null) => { req?.resolve(v); setReq(null); };
  const confirm = async (a: Omit<Ask, "input">) => (await open(a)) !== null;
  const prompt = (a: Ask & { input: string }) => open(a);
  const submit = () => close(req?.input !== undefined ? value : "");

  const dialog = req && (
    <div className="modal-bg" onClick={() => close(null)}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
           onKeyDown={(e) => e.key === "Escape" && close(null)}>
        <h3>{req.title}</h3>
        {req.body && <div className="modal-body">{req.body}</div>}
        {req.input !== undefined && (
          <input className="wide" autoFocus value={value} onFocus={(e) => e.target.select()}
                 onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && value.trim() && submit()} />
        )}
        <div className="modal-actions">
          <button onClick={() => close(null)} autoFocus={req.input === undefined}>Cancel</button>
          <button className={req.danger ? "danger solid" : "primary"}
                  disabled={req.input !== undefined && !value.trim()} onClick={submit}>{req.ok ?? "OK"}</button>
        </div>
      </div>
    </div>
  );
  return { confirm, prompt, dialog };
}
