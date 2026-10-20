import { useEffect, useRef, useState } from "react";
import "./Startup.css";

export default function Startup({ loading, motion, onDone }: { loading: boolean; motion: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<"notice" | "reveal" | "exit">("notice");
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  const done = useRef(onDone); done.current = onDone;
  const reduced = !motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 4500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (phase !== "notice" || !ready) return;
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPhase("reveal"); } };
    window.addEventListener("keydown", keyboard);
    let frame = 0; let wasPressed = true;
    const tick = () => {
      let pressed = false;
      try { pressed = Array.from(navigator.getGamepads?.() ?? []).some((pad) => pad?.buttons[0]?.pressed); } catch { /* Manette indisponible. */ }
      if (pressed && !wasPressed && document.hasFocus()) setPhase("reveal");
      wasPressed = pressed; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { window.removeEventListener("keydown", keyboard); cancelAnimationFrame(frame); };
  }, [phase, ready]);
  useEffect(() => {
    if (phase !== "reveal") return;
    const timer = window.setTimeout(() => setPhase("exit"), reduced ? 600 : 8000);
    return () => window.clearTimeout(timer);
  }, [phase, reduced]);
  useEffect(() => {
    if (phase !== "exit") return;
    const timer = window.setTimeout(() => done.current(), reduced ? 0 : 700);
    return () => window.clearTimeout(timer);
  }, [phase, reduced]);
  return <div className={`raye-startup ${reduced ? "startup-still" : ""} ${phase === "exit" ? "startup-exit" : ""}`} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
    {phase === "notice" ? <section className="startup-notice" role="dialog" aria-labelledby="startup-notice-title">
      <div className="startup-small-brand">RAYE SQUARE</div><span className="startup-warning-icon" aria-hidden="true">!</span>
      <h1 id="startup-notice-title">Photosensibilité</h1>
      <p>Certains jeux contiennent des lumières clignotantes ou des motifs susceptibles de déclencher une crise chez les personnes photosensibles.</p>
      <p>Consulte les avertissements de chaque jeu. En cas de malaise, arrête de jouer et demande un avis médical.</p>
      <button autoFocus disabled={!ready} onClick={() => setPhase("reveal")}>{ready ? "✕  Continuer · Entrée" : "Lis cet avertissement…"}</button>
    </section> : <div className="startup-stage" aria-label="Démarrage de Raye Square" role="status">
      <div className="startup-halo" /><div className="startup-orbit orbit-one" /><div className="startup-orbit orbit-two" /><div className="startup-horizon" />
      <div className="startup-logo-wrap">{missing ? <div className="startup-wordmark">raye square</div> : <img src="/logo.png" alt="Raye Square" onError={() => setMissing(true)} draggable={false} />}</div>
      <p className="startup-tagline">TON ESPACE DE JEU</p><span className="startup-load">{loading ? "Préparation de la bibliothèque…" : "Prêt à jouer"}</span>
    </div>}
  </div>;
}

