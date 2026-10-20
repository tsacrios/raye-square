import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./Updates.css";

let initialCheck: Promise<Update | null> | undefined;
export default function Updates() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    if (!import.meta.env.DEV) {
      initialCheck ??= check({ timeout: 10000 });
      void initialCheck.then((value) => { if (active && value) { setUpdate(value); setVisible(true); } }).catch(() => {});
    }
    return () => { active = false; };
  }, []);
  async function verify() {
    setVisible(true); setBusy(true); setMessage("Recherche…");
    try { const value = await check({ timeout: 10000 }); setUpdate(value); setMessage(value ? "" : "Raye Square est à jour."); }
    catch { setMessage("Vérification indisponible. Vérifie ta connexion ou réessaie plus tard."); }
    finally { setBusy(false); }
  }
  async function install() {
    if (!update || busy) return;
    setBusy(true); setMessage("Téléchargement de la mise à jour…");
    try {
      await update.downloadAndInstall((event) => { if (event.event === "Finished") setMessage("Installation…"); });
      setMessage("Redémarrage…"); await relaunch();
    } catch { setMessage("La mise à jour a échoué. Tu peux réessayer plus tard."); setBusy(false); }
  }
  return <div className="raye-updates">
    {visible ? <section role="dialog" aria-label="Mises à jour">
      <strong>{update ? `Version ${update.version} disponible` : "Mises à jour"}</strong>
      {update && <p>Ferme ton jeu avant de continuer. L’application redémarrera après l’installation.</p>}
      <p role="status">{message}</p>
      {update && <button disabled={busy} onClick={() => void install()}>Installer et redémarrer</button>}
      <button disabled={busy} onClick={() => setVisible(false)}>{update ? "Plus tard" : "Fermer"}</button>
    </section> : <button onClick={() => void verify()}>Mises à jour</button>}
  </div>;
}