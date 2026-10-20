import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./QuickMenu.css";

type Status = {
  game: string | null;
  controller: boolean;
  input_error: string | null;
  volume: number | null;
  audio_error: string | null;
};
type Confirmation = "quit" | "shutdown" | "restart" | null;
type SymbolName = "play" | "home" | "volume" | "close" | "power" | "back";

function Symbol({ name }: { name: SymbolName }) {
  const paths: Record<SymbolName, React.ReactNode> = {
    play: <path d="m9 5 11 7-11 7Z" />,
    home: <><path d="m3 11 9-8 9 8v10h-6v-7H9v7H3Z" /></>,
    volume: <><path d="M3 9h4l5-5v16l-5-5H3Z" /><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    power: <><path d="M12 2v10" /><path d="M6 5a9 9 0 1 0 12 0" /></>,
    back: <path d="m14 5-7 7 7 7" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}


// Conserver une sélection utilisable après un changement de page ou de boutons.
function useStableFocus(selector: string, scopeSelector: string) {
  useEffect(() => {
    let remembered: HTMLElement | null = null;
    let frame = 0;
    let stopped = false;
    const items = () => {
      const scope = document.querySelector(scopeSelector) ?? document.querySelector("main");
      return Array.from(scope?.querySelectorAll<HTMLElement>(selector) ?? [])
        .filter((item) => !item.matches(":disabled") && !item.closest("[inert]") && item.getClientRects().length > 0);
    };
    const remember = () => {
      const current = document.activeElement;
      if (current instanceof HTMLElement && items().includes(current)) remembered = current;
    };
    const repair = () => {
      frame = 0;
      if (stopped || !document.hasFocus()) return;
      const available = items();
      if (!available.length) return;
      const current = document.activeElement;
      if (current instanceof HTMLElement && available.includes(current)) { remembered = current; return; }
      // Ne pas détourner le focus d'une saisie de texte.
      if (current instanceof HTMLElement && current.matches("input, textarea, [contenteditable=true]") && current.isConnected) return;
      const sameGame = remembered?.dataset.game;
      const next = (remembered && available.includes(remembered) ? remembered : null)
        ?? (sameGame ? available.find((item) => item.dataset.game === sameGame) : undefined)
        ?? available[0];
      next.focus({ preventScroll: true });
      remembered = next;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(repair); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "inert"] });
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", schedule);
    window.addEventListener("focus", schedule);
    schedule();
    return () => {
      stopped = true; observer.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("focus", schedule);
    };
  }, [selector, scopeSelector]);
}

function playUiSound(kind: "move" | "accept" | "back") {
  try {
    if (JSON.parse(localStorage.getItem("console.preferences") ?? "null")?.sounds === false) return;
  } catch { /* Préférences par défaut. */ }
  void invoke("ui_sound", { kind }).catch(() => {});
}

function useUiSounds(selector: string) {
  useEffect(() => {
    let lastFocus: EventTarget | null = null;
    let lastMove = 0;
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(selector) || target === lastFocus) return;
      const first = lastFocus === null;
      lastFocus = target;
      if (!document.hasFocus() || first) return;
      const now = performance.now();
      if (now - lastMove < 85) return;
      lastMove = now;
      playUiSound("move");
    };
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!target || target.matches(":disabled")) return;
      const label = target.getAttribute("aria-label") ?? target.textContent ?? "";
      playUiSound(/annuler|retour|fermer/i.test(label) ? "back" : "accept");
    };
    window.addEventListener("focusin", focus);
    window.addEventListener("click", click, true);
    return () => { window.removeEventListener("focusin", focus); window.removeEventListener("click", click, true); };
  }, [selector]);
}

function PowerScreen({ action }: { action: "restart" | "shutdown" }) {
  const [missing, setMissing] = useState(false);
  return <div className="raye-power-screen" role="status" aria-live="polite">
    <style>{`
      .raye-power-screen { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 28px; background: #050607; color: #f2f4f7; font-family: "Segoe UI", sans-serif; animation: raye-power-in 350ms ease both; }
      .raye-power-screen img { width: min(65vw, 620px); height: auto; object-fit: contain; }
      .raye-power-name { font-size: clamp(28px, 5vw, 58px); letter-spacing: -.04em; font-weight: 650; }
      .raye-power-screen p { margin: 0; font-size: 17px; color: #bac1cd; }
      .raye-power-track { width: 92px; height: 2px; margin-top: 8px; overflow: hidden; background: #ffffff20; border-radius: 2px; }
      .raye-power-track span { display: block; width: 34px; height: 100%; background: #e9edf5; animation: raye-power-line 1400ms ease-in-out infinite alternate; }
      @keyframes raye-power-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes raye-power-line { from { transform: translateX(-34px); } to { transform: translateX(92px); } }
      @media (prefers-reduced-motion: reduce) { .raye-power-screen, .raye-power-track span { animation: none; } .raye-power-track span { width: 100%; } }
    `}</style>
    {missing ? <div className="raye-power-name">raye square</div> : <img src="/logo.png" alt="Raye Square" draggable={false} onError={() => setMissing(true)} />}
    <p>{action === "restart" ? "Redémarrage…" : "À bientôt."}</p>
    <div className="raye-power-track" aria-hidden="true"><span /></div>
  </div>;
}
export default function QuickMenu() {
  const [powerScreen, setPowerScreen] = useState<"restart" | "shutdown" | null>(null);
  useUiSounds('[data-quick]');
  useStableFocus('[data-quick]', '.quick-content');
  const [status, setStatus] = useState<Status | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [power, setPower] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(new Date());
  const [busy, setBusy] = useState(false);
  const actionRef = useRef<(action: string) => void>(() => {});
  const actionBusy = useRef(false);
  const volumeBusy = useRef(false);
  const mounted = useRef(true);
  const selectedItem = useRef<HTMLElement | null>(null);
  function selectItem(item?: HTMLElement) {
    if (!item) return;
    document.querySelectorAll("[data-quick-selected]").forEach((element) => element.removeAttribute("data-quick-selected"));
    selectedItem.current = item;
    item.setAttribute("data-quick-selected", "true");
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  async function refresh() {
    try {
      const result = await invoke<Status>("quick_status");
      if (mounted.current) setStatus(result);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    }
  }

  function focusFirst() {
    window.setTimeout(() => {
      if (mounted.current) selectItem(document.querySelector<HTMLElement>(".quick-content [data-quick]:not(:disabled)") ?? undefined);
    }, 80);
  }

  async function run(action: string, confirmed = false) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    setError("");
    let acceptedPower = false;
    try {
      if (confirmed && (action === "restart" || action === "shutdown")) {
        setPowerScreen(action);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
      }
      await invoke("quick_action", { action, confirmed });
      acceptedPower = confirmed && (action === "restart" || action === "shutdown");
    } catch (reason) {
      setPowerScreen(null);
      setError(String(reason));
    } finally {
      actionBusy.current = acceptedPower;
      if (mounted.current) setBusy(false);
    }
  }

  async function volume(delta: number) {
    if (volumeBusy.current) return;
    volumeBusy.current = true;
    setError("");
    try {
      const value = await invoke<number>("quick_volume", { delta });
      if (mounted.current) setStatus((previous) => previous ? { ...previous, volume: value, audio_error: null } : previous);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally { volumeBusy.current = false; }
  }

  function back() {
    if (confirmation) { setConfirmation(null); focusFirst(); }
    else if (power) { setPower(false); focusFirst(); }
    else void run("resume");
  }

  actionRef.current = (action) => {
    if (actionBusy.current) return;
    if (action === "back") { playUiSound("back"); back(); return; }
    const items = Array.from(document.querySelectorAll<HTMLElement>(".quick-content [data-quick]:not(:disabled)"));
    if (!items.length) return;
    const domFocus = document.activeElement as HTMLElement;
    const focused = document.hasFocus() && items.includes(domFocus) ? domFocus
      : selectedItem.current && items.includes(selectedItem.current) ? selectedItem.current : items[0];
    let index = items.indexOf(focused);
    selectItem(focused);
    if (action === "accept") {
      if (index < 0) items[0]?.focus({ preventScroll: true });
      else if (focused.dataset.volume !== undefined) void volume(5);
      else focused.click();
      return;
    }
    if ((action === "left" || action === "right") && focused.dataset.volume !== undefined) {
      void volume(action === "left" ? -5 : 5);
      return;
    }
    if (action === "up" || action === "down") {
      index = index < 0 ? 0 : (index + (action === "up" ? -1 : 1) + items.length) % items.length;
      const next = items[index];
      selectItem(next);
    }
  };

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const register = async () => {
      const results = await Promise.allSettled([
        listen("quick-open", () => {
          if (disposed) return;
          setConfirmation(null); setPower(false); setError("");
          setClock(new Date()); void refresh(); focusFirst();
        }),
        listen<string>("quick-input", ({ payload }) => { if (!disposed) actionRef.current(payload); }),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) result.value(); else cleanups.push(result.value);
        } else if (!disposed) setError("Détection des boutons indisponible. Ferme et relance Raye Square.");
      }
    };
    void register(); void refresh(); focusFirst();
    const timer = window.setInterval(() => setClock(new Date()), 30000);
    const keyboard = (event: KeyboardEvent) => {
      const action = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "accept", " ": "accept", Escape: "back" } as Record<string, string>)[event.key];
      if (action) { event.preventDefault(); actionRef.current(action); }
      if (event.key === "Tab") {
        const items = Array.from(document.querySelectorAll<HTMLElement>("[data-quick]:not(:disabled)"));
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (items.length) { event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus({ preventScroll: true }); }
      }
    };
    const focused = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches("[data-quick]")) {
        selectedItem.current = event.target;
        document.querySelectorAll("[data-quick-selected]").forEach((element) => element.removeAttribute("data-quick-selected"));
        event.target.setAttribute("data-quick-selected", "true");
      }
    };
    window.addEventListener("focusin", focused);
    window.addEventListener("keydown", keyboard);
    return () => {
      disposed = true; mounted.current = false;
      cleanups.forEach((cleanup) => cleanup());
      window.clearInterval(timer); window.removeEventListener("keydown", keyboard); window.removeEventListener("focusin", focused);
    };
  }, []);

  const confirmationTitle = confirmation === "quit" ? "Quitter le jeu ?" : confirmation === "restart" ? "Redémarrer le PC ?" : "Éteindre le PC ?";
  if (powerScreen) return <PowerScreen action={powerScreen} />;
  return (
    <main className="quick-shell" onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}>
      <style>{`.quick-row[data-quick-selected=true] { background: #ffffff17; border-color: #ffffffd0; outline: 2px solid #ffffffd0; outline-offset: 2px; }`}</style>
      <div className="quick-dim" onClick={() => void run("resume")} />
      <aside className="quick-sidebar" role="dialog" aria-modal="true" aria-labelledby="quick-title">
        <header className="quick-header"><span className="quick-brand">RAYE SQUARE</span><time>{clock.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time></header>
        <div className="quick-intro"><span className="quick-eyebrow">MENU RAPIDE</span><h1 id="quick-title">{confirmation ? confirmationTitle : power ? "Alimentation" : "À portée de main"}</h1><p>{status?.game || "Ton espace de jeu"}</p></div>
        <div className="quick-content">
          {confirmation ? (
            <section className="quick-confirm">
              <p>{confirmation === "quit" ? "Enregistre ta progression avant de continuer. Le jeu recevra une demande de fermeture." : "Enregistre ta partie et tes documents avant de continuer."}</p>
              <button data-quick className="quick-row" onClick={back}><Symbol name="back" /><span>Annuler</span></button>
              <button data-quick className="quick-row quick-danger" disabled={busy} onClick={() => void run(confirmation, true)}><Symbol name={confirmation === "quit" ? "close" : "power"} /><span>{confirmation === "quit" ? "Quitter le jeu" : confirmation === "restart" ? "Redémarrer" : "Éteindre"}</span></button>
            </section>
          ) : power ? (
            <>
              <button data-quick className="quick-row" onClick={back}><Symbol name="back" /><span>Retour</span></button>
              <button data-quick className="quick-row" onClick={() => { setConfirmation("restart"); focusFirst(); }}><Symbol name="power" /><span>Redémarrer le PC</span></button>
              <button data-quick className="quick-row" onClick={() => { setConfirmation("shutdown"); focusFirst(); }}><Symbol name="power" /><span>Éteindre le PC</span></button>
            </>
          ) : (
            <>
              <button data-quick className="quick-row" disabled={busy} onClick={() => void run("resume")}><Symbol name="play" /><span>Reprendre<small>Fermer le menu</small></span></button>
              <button data-quick className="quick-row" disabled={busy} onClick={() => void run("home")}><Symbol name="home" /><span>Accueil<small>Le jeu reste ouvert</small></span></button>
              <button data-quick data-volume className="quick-row quick-volume" disabled={status?.volume == null} onClick={() => void volume(5)} aria-label={`Volume ${status?.volume ?? "indisponible"}, flèche gauche pour baisser et droite pour augmenter`}>
                <Symbol name="volume" /><span>Volume<span className="quick-volume-line"><span className="quick-meter"><span style={{ width: `${status?.volume ?? 0}%` }} /></span><strong>{status?.volume == null ? "—" : `${status.volume}%`}</strong></span><small>◀ / ▶ pour régler</small></span>
              </button>
              <button data-quick className="quick-row" disabled={busy || !status?.game} onClick={() => { setConfirmation("quit"); focusFirst(); }}><Symbol name="close" /><span>Quitter le jeu<small>Enregistrer avant de quitter</small></span></button>
              <button data-quick className="quick-row" onClick={() => { setPower(true); focusFirst(); }}><Symbol name="power" /><span>Alimentation</span></button>
            </>
          )}
          {(error || status?.input_error || status?.audio_error) && <p className="quick-error" role="status">{error || status?.input_error || status?.audio_error}</p>}
        </div>
        <footer className="quick-footer"><span className="quick-controller"><i className={status?.controller ? "connected" : ""} />{status?.controller ? "DualSense · USB" : "PS · ou Ctrl + Maj + Q"}</span><div><span><b>✕</b> Valider</span><span><b>◯</b> Retour</span></div></footer>
      </aside>
    </main>
  );
}





