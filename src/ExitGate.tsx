import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function ExitGate({ onCancel, setupOnly = false }: { onCancel: () => void; setupOnly?: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void invoke<boolean>("exit_code_status").then((value) => { if (alive.current) setConfigured(value); }).catch((reason) => { if (alive.current) setError(String(reason)); });
    return () => { alive.current = false; };
  }, []);
  const add = (digit: string) => { if (!busyRef.current) { setPin((p) => (p + digit).slice(0, 6)); setError(""); } };
  const remove = () => { if (!busyRef.current) setPin((p) => p.slice(0, -1)); };
  async function submit() {
    if (busyRef.current || pin.length !== 6 || configured === null) return;
    if (!configured && !first) { setFirst(pin); setPin(""); return; }
    if (!configured && pin !== first) { setError("Les deux codes sont différents. Recommence."); setFirst(""); setPin(""); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (!configured) {
        await invoke("exit_code_create", { pin });
        if (setupOnly && alive.current) { onCancel(); return; }
        if (alive.current) { setConfigured(true); setPin(""); setFirst(""); setError("Code enregistré. Saisis-le pour quitter."); }
      } else await invoke("exit_code_quit", { pin });
    } catch (reason) { if (alive.current) { setError(String(reason)); setPin(""); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const actions = useRef({ add, remove, submit }); actions.current = { add, remove, submit };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); actions.current.add(event.key); }
      if (event.key === "Backspace") { event.preventDefault(); actions.current.remove(); }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  return <section className="exit-gate">
    <style>{`.exit-gate { max-width: 380px; margin: auto; text-align: center; } .exit-gate p { color: #b8c2d0; line-height: 1.5; } .exit-dots { font-size: 32px; letter-spacing: 12px; margin: 24px 0; } .exit-keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; } .exit-keypad button { padding: 15px; border-radius: 10px; color: white; background: #ffffff0c; border: 1px solid #ffffff24; font: inherit; } .exit-actions { display: flex; gap: 12px; justify-content: center; margin: 22px 0; } .exit-gate .exit-message { color: #e1c79d; min-height: 24px; }`}</style>
    <p>{configured === null ? "Vérification…" : configured ? "Saisis le code pour quitter Raye Square." : first ? "Confirme ton nouveau code." : "Choisis un code de sortie à six chiffres."}</p>
    <div className="exit-dots" aria-label={`${pin.length} chiffres saisis`}>{Array.from({ length: 6 }, (_, i) => i < pin.length ? "●" : "○").join("")}</div>
    <div className="exit-keypad">{"123456789".split("").map((digit) => <button data-pad key={digit} disabled={busy || configured === null} onClick={() => add(digit)}>{digit}</button>)}<button data-pad disabled={busy || configured === null} onClick={remove} aria-label="Effacer un chiffre">⌫</button><button data-pad disabled={busy || configured === null} onClick={() => add("0")}>0</button><button data-pad disabled={busy || pin.length !== 6 || configured === null} onClick={() => void submit()}>OK</button></div>
    <p className="exit-message" role="status">{error}</p>
    <div className="exit-actions"><button data-pad className="soft-button" disabled={busy} onClick={onCancel}>Annuler</button></div>
  </section>;
}
