import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import Startup from "./Startup";
import ExitGate from "./ExitGate";

type Game = {
  app_id: string;
  name: string;
  library?: string;
};

type Tab = "Accueil" | "Bibliothèque" | "Recherche";
type Modal = "settings" | "power" | "keyboard" | "exit" | null;
type BootPhase = "show" | "exit" | "done";

type IconName =
  | "home"
  | "library"
  | "search"
  | "store"
  | "settings"
  | "power"
  | "pad"
  | "download"
  | "play"
  | "star"
  | "sound"
  | "network"
  | "desktop"
  | "close";

const paths: Record<IconName, string> = {
  home: "m3 10 9-7 9 7v10h-6v-7H9v7H3Z",
  library: "M4 4v16M9 4v16M14 4v16m4-15 3 14",
  search: "M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  store: "M4 8h16l1 13H3ZM8 8V6a4 4 0 0 1 8 0v2",
  settings:
    "m9 3-1 3-3 1-2 4 2 2v3l3 2 3-1 3 1 3-2v-3l2-2-2-4-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  power: "M12 2v10M6 5a9 9 0 1 0 12 0",
  pad:
    "M7 7h10c3 0 5 12 3 13-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 19 4 7 7 7Zm1 3v6m-3-3h6m5-1h.01m3 3h.01",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  play: "m8 4 13 8-13 8Z",
  star: "m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z",
  sound: "M3 9h4l5-5v16l-5-5H3Zm13-1a6 6 0 0 1 0 8",
  network:
    "M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0m-4 4h.01",
  desktop: "M3 3h18v13H3Zm9 13v5m-5 0h10",
  close: "m6 6 12 12M6 18 18 6",
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function useSaved<T,>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Le stockage local peut être indisponible.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/* Illustrations Steam */

const assetCache = new Map<string, Promise<string | null>>();

function localAsset(id: string, kind: string) {
  const key = `${id}/${kind}`;

  if (!assetCache.has(key)) {
    assetCache.set(
      key,
      invoke<number[] | null>("get_artwork", {
        appId: id,
        kind,
      })
        .then((bytes) => {
          if (!bytes) return null;

          const array = new Uint8Array(bytes);

          const type =
            array[0] === 137
              ? "image/png"
              : array[0] === 82
                ? "image/webp"
                : "image/jpeg";

          return URL.createObjectURL(
            new Blob([array], { type }),
          );
        })
        .catch(() => null),
    );
  }

  return assetCache.get(key)!;
}

function Art({
  game,
  kind,
  className,
}: {
  game: Game;
  kind: "cover" | "hero" | "logo";
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let active = true;

    const files = {
      cover: "library_600x900.jpg",
      hero: "library_hero.jpg",
      logo: "logo.png",
    };

    localAsset(game.app_id, kind).then((url) => {
      if (active) {
        setSrc(
          url ??
            `https://cdn.akamai.steamstatic.com/steam/apps/${game.app_id}/${files[kind]}`,
        );
      }
    });

    return () => {
      active = false;
    };
  }, [game.app_id, kind]);

  if (failed || !src) {
    return kind === "logo" ? (
      <h1 className="title-fallback">{game.name}</h1>
    ) : null;
  }

  return (
    <img
      className={className}
      src={src}
      alt={kind === "logo" ? game.name : ""}
      onError={() => {
        if (kind !== "logo" && !fallback) {
          setFallback(true);

          setSrc(
            `https://cdn.akamai.steamstatic.com/steam/apps/${game.app_id}/header.jpg`,
          );
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

/* Navigation manette et clavier */

function moveFocus(direction: "left" | "right" | "up" | "down") {
  const scope =
    document.querySelector("[data-modal]") ??
    document.querySelector("main");

  const items = Array.from(
    scope?.querySelectorAll<HTMLElement>(
      "[data-pad]:not(:disabled)",
    ) ?? [],
  ).filter((element) => element.getClientRects().length);

  const current = document.activeElement as HTMLElement;

  if (!items.includes(current)) {
    items[0]?.focus();
    return;
  }

  const box = current.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

  let best: HTMLElement | undefined;
  let score = Infinity;

  for (const item of items) {
    if (item === current) continue;

    const rect = item.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - x;
    const dy = rect.top + rect.height / 2 - y;

    const along =
      direction === "left" ? -dx :
      direction === "right" ? dx :
      direction === "up" ? -dy : dy;

    const across =
      direction === "left" || direction === "right"
        ? Math.abs(dy)
        : Math.abs(dx);

    const nextScore = along + across * 3;

    if (along > 8 && nextScore < score) {
      best = item;
      score = nextScore;
    }
  }

  best?.focus();

  best?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "auto",
  });
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
function App() {
  const [powerScreen, setPowerScreen] = useState<"restart" | "shutdown" | null>(null);
  const powerPending = useRef(false);
  useUiSounds('[data-pad]');
  useStableFocus('[data-pad]', '[data-modal]');
  const [bootPhase, setBootPhase] = useState<BootPhase>("show");

  const [quickOpen, setQuickOpen] = useState(false);
  const quickOpenRef = useRef(false);
  const bootActive = useRef(bootPhase !== "done");
  bootActive.current = bootPhase !== "done";


  const launchLock = useRef(false);
  const sessionEventsReady = useRef(false);

  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<Tab>("Accueil");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Tous");

  const [favorites, setFavorites] = useSaved<string[]>(
    "console.favorites",
    [],
  );

  const [recent, setRecent] = useSaved<string[]>(
    "console.recent",
    [],
  );

  const [prefs, setPrefs] = useSaved("console.preferences", {
    motion: true,
    backgrounds: true,
    sounds: true,
  });

  const [modal, setModal] = useState<Modal>(null);
  const [exitSetup, setExitSetup] = useState(false);
  useEffect(() => {
    if (bootPhase !== "done") return;
    let disposed = false;
    void invoke<boolean>("exit_code_status").then((configured) => {
      if (!disposed && !configured) { setExitSetup(true); setModal("exit"); }
    }).catch((reason) => { if (!disposed) setToast(String(reason)); });
    return () => { disposed = true; };
  }, [bootPhase]);

  const [confirmPower, setConfirmPower] = useState<
    "shutdown" | "restart" | null
  >(null);

  const [controller, setController] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [toast, setToast] = useState("");
  const [launching, setLaunching] = useState(false);

  const actionRef = useRef<(action: string) => void>(() => {});
  const previousFocus = useRef<HTMLElement | null>(null);

  const tabs: Tab[] = ["Accueil", "Bibliothèque", "Recherche"];

  const selected =
    games.find((game) => game.app_id === selectedId) ?? games[0];

  const sorted = [...games].sort((a, b) => {
    const ai = recent.indexOf(a.app_id);
    const bi = recent.indexOf(b.app_id);

    return (
      (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) ||
      a.name.localeCompare(b.name)
    );
  });

  const visible = sorted.filter(
    (game) =>
      game.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter !== "Favoris" || favorites.includes(game.app_id)),
  );

  async function refresh() {
    setLoading(true);

    try {
      const result = await invoke<{
        games: Game[];
        warnings: string[];
      }>("get_steam_games");

      setGames(result.games);
      setWarnings(result.warnings);

      setSelectedId((id) =>
        result.games.some((game) => game.app_id === id)
          ? id
          : (
              result.games.find(
                (game) => game.app_id === recent[0],
              )?.app_id ??
              result.games[0]?.app_id ??
              ""
            ),
      );
    } catch (error) {
      setToast(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function call(
    command: string,
    args: Record<string, unknown> = {},
  ) {
    try {
      if (command === "system_action" && (args.action === "restart" || args.action === "shutdown")) {
        if (powerPending.current) return false;
        powerPending.current = true;
        setPowerScreen(args.action);
        // Laisser le temps à React d'afficher notre écran avant de demander l'arrêt.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
      }
      await invoke(command, args);
      return true;
    } catch (error) {
      powerPending.current = false;
      setPowerScreen(null);
      setToast(String(error));
      return false;
    }
  }

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const register = async () => {
      const results = await Promise.allSettled([
        listen<boolean>("quick-visibility", ({ payload }) => {
          if (disposed) return;
          quickOpenRef.current = payload; setQuickOpen(payload);
        }),
        listen("exit-request", () => { if (!disposed) { setExitSetup(false); setModal("exit"); } }),
        listen("quick-home", () => {
          if (disposed) return;
          setModal(null);
          setConfirmPower(null);
          setTab("Accueil");
          setQuery("");
          setFilter("Tous");
          window.setTimeout(() => {
            if (!disposed) document.querySelector<HTMLElement>(".featured .play-button")?.focus({ preventScroll: true });
          }, 100);
        }),
        listen<string>("game-ended", ({ payload: appId }) => {
          if (disposed) return;
          setModal(null);
          setConfirmPower(null);
          setQuery("");
          setFilter("Tous");
          setSelectedId(appId);
          setTab("Accueil");
          launchLock.current = false;
          setLaunching(false);
          window.setTimeout(() => {
            if (!disposed) {
              document.querySelector<HTMLElement>(".featured .play-button")
                ?.focus({ preventScroll: true });
            }
          }, 100);
        }),
        listen<string>("game-monitor-unavailable", () => {
          if (disposed) return;
          launchLock.current = false;
          setLaunching(false);
          setToast("Steam n'a pas confirmé l'état du jeu. Le retour automatique est indisponible pour cette partie.");
        }),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) result.value();
          else unlisteners.push(result.value);
        }
      }
      if (!disposed) {
        sessionEventsReady.current = results.every((result) => result.status === "fulfilled");
        if (!sessionEventsReady.current) {
          for (const unlisten of unlisteners.splice(0)) unlisten();
          setToast("Impossible d'initialiser le retour automatique. Redémarre Raye Square.");
        }
      }
    };
    void register();
    return () => {
      disposed = true;
      sessionEventsReady.current = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
  async function launch(game = selected) {
    if (!game || launchLock.current) return;
    if (!sessionEventsReady.current) {
      setToast("Initialisation du suivi des jeux… Réessaie dans un instant.");
      return;
    }

    launchLock.current = true;
    setLaunching(true);

    if (
      await call("launch_game", {
        appId: game.app_id,
      })
    ) {
      setRecent((ids) =>
        [
          game.app_id,
          ...ids.filter((id) => id !== game.app_id),
        ].slice(0, 20),
      );

      setToast(`Lancement transmis à Steam · ${game.name}`);
    }

    window.setTimeout(() => {
      launchLock.current = false;
      setLaunching(false);
    }, 2000);
  }

  function favorite() {
    if (!selected) return;

    setFavorites((ids) =>
      ids.includes(selected.app_id)
        ? ids.filter((id) => id !== selected.app_id)
        : [...ids, selected.app_id],
    );
  }

  function changeTab(next: Tab) {
    setTab(next);
    setQuery("");
    setFilter("Tous");
    window.scrollTo({ top: 0 });
  }

  function dismiss() {
    setModal(null);
    setConfirmPower(null);
  }

  actionRef.current = (action) => {
    if (bootActive.current || powerPending.current || quickOpenRef.current) return;

    if (action === "back") {
      playUiSound('back');
      if (modal) {
        dismiss();
      } else {
        changeTab("Accueil");

        window.setTimeout(() => {
          document
            .querySelector<HTMLElement>(".play-button")
            ?.focus();
        }, 0);
      }
    }

    if (action === "accept") {
      const target = document.activeElement as HTMLElement;

      if (target?.dataset.game) {
        const game = games.find(
          (item) => item.app_id === target.dataset.game,
        );

        if (game) { playUiSound("accept"); void launch(game); }
      } else {
        target?.click();
      }
    }

    if (action === "favorite" && !modal) {
      favorite();
    }

    if (action === "settings") {
      if (modal) dismiss();
      else setModal("settings");
    }

    if (
      (action === "prev" || action === "next") &&
      !modal
    ) {
      changeTab(
        tabs[
          (
            tabs.indexOf(tab) +
            (action === "next" ? 1 : 2)
          ) % tabs.length
        ],
      );

      window.setTimeout(() => {
        document
          .querySelector<HTMLElement>(".navigation .active")
          ?.focus();
      }, 0);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);


  useEffect(() => {
    if (bootPhase === "done" && controller) {
      document
        .querySelector<HTMLElement>(
          ".play-button, [data-pad]",
        )
        ?.focus();
    }
  }, [bootPhase, controller]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setClock(new Date()),
      1000,
    );

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(
      () => setToast(""),
      6000,
    );

    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (modal) {
      previousFocus.current =
        document.activeElement as HTMLElement;

      document
        .querySelector<HTMLElement>(
          "[data-modal] [data-pad]",
        )
        ?.focus();
    } else {
      previousFocus.current?.focus();
    }
  }, [modal]);

  useEffect(() => {
    if (modal === "power") {
      document
        .querySelector<HTMLElement>(
          "[data-modal] .confirmation [data-pad], " +
          "[data-modal] .settings-list [data-pad]",
        )
        ?.focus();
    }
  }, [confirmPower]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (bootActive.current || powerPending.current || quickOpenRef.current) return;

      if (event.key === "F11") {
        event.preventDefault();

        void call("window_action", {
          action: "fullscreen",
        });

        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        actionRef.current("back");
        return;
      }

      if (modal && event.key === "Tab") {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-modal] [data-pad]:not(:disabled)",
          ),
        );

        if (!items.length) return;

        const index = items.indexOf(
          document.activeElement as HTMLElement,
        );

        event.preventDefault();

        items[
          (
            index +
            (event.shiftKey ? items.length - 1 : 1)
          ) % items.length
        ]?.focus();

        return;
      }

      if (
        (event.target as HTMLElement).tagName === "INPUT"
      ) return;

      const directions: Record<
        string,
        "left" | "right" | "up" | "down"
      > = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };

      const direction = directions[event.key];

      if (direction) {
        event.preventDefault();
        moveFocus(direction);
      }

      if (
        event.key === "Enter" &&
        (event.target as HTMLElement).dataset.game
      ) {
        event.preventDefault();
        actionRef.current("accept");
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modal]);

  useEffect(() => {
    let frame = 0;
    let previous: boolean[] = [];
    let lastDirection = "";
    let nextRepeat = 0;
    let wasConnected = false;

    function tick(time: number) {
      let pad: Gamepad | undefined;

      try {
        pad = Array.from(
          navigator.getGamepads?.() ?? [],
        ).find((item) => item?.connected) ?? undefined;
      } catch {
        // API manette indisponible.
      }

      const connected = Boolean(pad);

      if (connected !== wasConnected) {
        wasConnected = connected;
        setController(connected);

        if (
          connected &&
          !bootActive.current &&
          document.activeElement === document.body
        ) {
          document
            .querySelector<HTMLElement>(
              ".play-button, [data-pad]",
            )
            ?.focus();
        }

        if (!connected) {
          previous = [];
          lastDirection = "";
        }
      }

      if (pad) {
        const pressed = pad.buttons.map(
          (button) => button.pressed,
        );

        const direction =
          pressed[14] || pad.axes[0] < -0.55 ? "left" :
          pressed[15] || pad.axes[0] > 0.55 ? "right" :
          pressed[12] || pad.axes[1] < -0.55 ? "up" :
          pressed[13] || pad.axes[1] > 0.55 ? "down" : "";

        if (
          !bootActive.current &&
          document.hasFocus() && !quickOpenRef.current &&
          direction &&
          (
            direction !== lastDirection ||
            time >= nextRepeat
          )
        ) {
          moveFocus(direction);

          nextRepeat =
            time +
            (direction !== lastDirection ? 380 : 160);
        }

        lastDirection = direction;

        if (
          !bootActive.current &&
          document.hasFocus() && !quickOpenRef.current
        ) {
          const actions = [
            [0, "accept"],
            [1, "back"],
            [3, "favorite"],
            [4, "prev"],
            [5, "next"],
            [9, "settings"],
          ] as const;

          for (const [index, action] of actions) {
            if (pressed[index] && !previous[index]) {
              actionRef.current(action);
            }
          }
        }

        previous = pressed;
      }

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      {powerScreen && <PowerScreen action={powerScreen} />}
      {bootPhase !== "done" && <Startup loading={loading} motion={prefs.motion} onDone={() => setBootPhase("done")} />}
      <style>{`
        .console [data-pad]:focus {
          outline: 3px solid white;
          outline-offset: 5px;
        }
        .console .game-card.selected:not(:focus) {
          border-width: 1px;
          border-color: #ffffff30;
          transform: none;
        }
      `}</style>
      <main
        inert={bootPhase !== "done" || powerScreen !== null || quickOpen}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
        className={[
          "console",
          !prefs.motion ? "no-motion" : "",
          tab !== "Accueil" ? "library-view" : "",
        ].join(" ")}
      >
        <div className="background">
          {selected && prefs.backgrounds && (
            <Art
              key={selected.app_id}
              game={selected}
              kind="hero"
              className="hero-art"
            />
          )}
        </div>

        <div className="scrim" />

        <header className="topbar">
          <nav className="navigation" aria-label="Navigation">
            {tabs.slice(0, 2).map((name, index) => (
              <button
                data-pad
                key={name}
                className={tab === name ? "active" : ""}
                onClick={() => changeTab(name)}
              >
                <Icon name={index ? "library" : "home"} />
                {name}
              </button>
            ))}

            <button
              data-pad
              onClick={() =>
                void call("open_steam", {
                  page: "store",
                  appId: null,
                })
              }
            >
              <Icon name="store" />
              Store
            </button>

            <button
              data-pad
              className={
                tab === "Recherche" ? "active" : ""
              }
              onClick={() => changeTab("Recherche")}
            >
              <Icon name="search" />
              Recherche
            </button>
          </nav>

          <div className="status">
            <span
              className={
                controller ? "pad connected" : "pad"
              }
              title={
                controller
                  ? "Manette connectée"
                  : "Appuie sur un bouton de ta manette"
              }
            >
              <Icon name="pad" />
            </span>

            <time>
              {clock.toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>

            <span className="profile">
              J
              <span />
            </span>
          </div>
        </header>

        {tab === "Accueil" ? (
          <section className="featured">
            <p className="eyebrow">
              {selected &&
              recent.includes(selected.app_id)
                ? "REPRENDRE LA PARTIE"
                : "DANS TA BIBLIOTHÈQUE"}
            </p>

            {selected ? (
              <Art
                key={selected.app_id}
                game={selected}
                kind="logo"
                className="game-logo"
              />
            ) : (
              <h1 className="title-fallback">
                {loading
                  ? "Un instant…"
                  : "Ta prochaine partie."}
              </h1>
            )}

            {selected && (
              <div className="hero-actions">
                <button
                  data-pad
                  className="play-button"
                  disabled={launching}
                  onClick={() => void launch()}
                >
                  <Icon name="play" />
                  {launching ? "Ouverture…" : "Jouer"}
                </button>

                <button
                  data-pad
                  className={`favorite-button ${
                    favorites.includes(selected.app_id)
                      ? "saved"
                      : ""
                  }`}
                  onClick={favorite}
                  aria-label={
                    favorites.includes(selected.app_id)
                      ? "Retirer des favoris"
                      : "Ajouter aux favoris"
                  }
                >
                  <Icon name="star" />
                </button>

                <span className="installed">
                  <span />
                  Installé · Steam
                </span>
              </div>
            )}
          </section>
        ) : (
          <section className="library-heading">
            <div className="heading-line">
              <h1>
                {tab === "Recherche"
                  ? "Recherche"
                  : "Bibliothèque"}
              </h1>

              <span>
                {games.length} jeux installés
              </span>
            </div>

            <div className="library-controls">
              {tab === "Recherche" ? (
                <>
                  <input
                    data-pad
                    aria-label="Rechercher un jeu"
                    placeholder="Nom du jeu…"
                    value={query}
                    onChange={(event) =>
                      setQuery(event.target.value)
                    }
                  />

                  <button
                    data-pad
                    className="soft-button"
                    onClick={() => setModal("keyboard")}
                  >
                    Clavier
                  </button>
                </>
              ) : (
                ["Tous", "Favoris"].map((name) => (
                  <button
                    data-pad
                    key={name}
                    className={`filter ${
                      filter === name ? "active" : ""
                    }`}
                    onClick={() => setFilter(name)}
                  >
                    {name}
                  </button>
                ))
              )}
            </div>
          </section>
        )}

        <section
          className="collection"
          aria-label="Jeux installés"
        >
          {tab === "Accueil" && (
            <div className="collection-label">
              <span>À toi de jouer</span>
              <span>{games.length} jeux</span>
            </div>
          )}

          <div
            className={
              tab === "Accueil"
                ? "game-row"
                : "game-grid"
            }
          >
            {visible.map((game) => (
              <button
                data-pad
                data-game={game.app_id}
                key={game.app_id}
                className={`game-card ${
                  selected?.app_id === game.app_id
                    ? "selected"
                    : ""
                }`}
                aria-label={game.name}
                aria-pressed={
                  selected?.app_id === game.app_id
                }
                onFocus={() =>
                  setSelectedId(game.app_id)
                }
                onClick={() =>
                  setSelectedId(game.app_id)
                }
                onDoubleClick={() =>
                  void launch(game)
                }
              >
                <Art
                  game={game}
                  kind="cover"
                  className="cover"
                />

                <span className="cover-shade" />

                <span className="card-name">
                  {game.name}
                </span>

                {favorites.includes(game.app_id) && (
                  <span className="card-favorite">
                    <Icon name="star" />
                  </span>
                )}
              </button>
            ))}
          </div>

          {!loading && !visible.length && (
            <div className="empty">
              <h2>
                {games.length
                  ? "Aucun jeu ici."
                  : "Aucun jeu installé détecté."}
              </h2>

              <p>
                {games.length
                  ? "Essaie un autre nom ou ajoute un jeu aux favoris."
                  : "Installe un jeu dans Steam, puis actualise la bibliothèque."}
              </p>

              <button
                data-pad
                className="soft-button"
                onClick={() => void refresh()}
              >
                Actualiser
              </button>
            </div>
          )}

          {!!warnings.length && (
            <p className="warning">
              Certaines bibliothèques sont
              inaccessibles. Consulte les réglages.
            </p>
          )}
        </section>

        <footer className="bottom-bar">
          <div className="utilities">
            <button
              data-pad
              aria-label="Bibliothèque"
              onClick={() =>
                changeTab("Bibliothèque")
              }
            >
              <Icon name="library" />
            </button>

            <button
              data-pad
              aria-label="Réglages"
              onClick={() =>
                setModal("settings")
              }
            >
              <Icon name="settings" />
            </button>

            <button
              data-pad
              aria-label="Alimentation"
              onClick={() =>
                setModal("power")
              }
            >
              <Icon name="power" />
            </button>
          </div>

          <div className="hints">
            {controller ? (
              <>
                <span>
                  <kbd>A</kbd> Choisir / jouer
                </span>
                <span>
                  <kbd>B</kbd> Retour
                </span>
                <span>
                  <kbd>Y</kbd> Favori
                </span>
                <span>
                  <kbd>LB RB</kbd> Onglets
                </span>
              </>
            ) : (
              <>
                <span>Double-clic pour jouer</span>
                <span>
                  <kbd>F11</kbd> Plein écran
                </span>
              </>
            )}
          </div>

          <button
            data-pad
            className="download-tile"
            onClick={() =>
              void call("open_steam", {
                page: "downloads",
                appId: null,
              })
            }
          >
            <Icon name="download" />

            <span>
              Téléchargements
              <small>Ouvrir dans Steam</small>
            </span>
          </button>
        </footer>

        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}

        {modal && (
          <div
            className="modal-backdrop"
            onMouseDown={(event) => {
              if (
                event.target === event.currentTarget
              ) {
                dismiss();
              }
            }}
          >
            <section
              data-modal
              className={`panel ${
                modal === "keyboard"
                  ? "keyboard-panel"
                  : ""
              }`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="panel-title"
            >
              <header>
                <div>
                  <p className="eyebrow">
                    RAYE SQUARE
                  </p>

                  <h2 id="panel-title">
                    {modal === "exit" ? "Sortie protégée" : modal === "settings"
                      ? "Réglages"
                      : modal === "keyboard"
                        ? "Rechercher un jeu"
                        : confirmPower
                          ? "Confirmer"
                          : "Alimentation"}
                  </h2>
                </div>

                <button
                  data-pad
                  className="icon-button"
                  aria-label="Fermer"
                  onClick={dismiss}
                >
                  <Icon name="close" />
                </button>
              </header>

              {modal === "exit" && <ExitGate onCancel={dismiss} setupOnly={exitSetup} />}
              {modal === "settings" && (
                <div className="settings-list">
                  <button
                    data-pad
                    onClick={() =>
                      void call("window_action", {
                        action: "fullscreen",
                      })
                    }
                  >
                    <Icon name="desktop" />

                    <span>
                      Plein écran
                      <small>
                        Basculer entre fenêtre
                        et plein écran
                      </small>
                    </span>

                    <kbd>F11</kbd>
                  </button>

                  <button
                    data-pad
                    onClick={() =>
                      setPrefs((previous) => ({
                        ...previous,
                        backgrounds:
                          !previous.backgrounds,
                      }))
                    }
                  >
                    <span>
                      Fonds de jeux
                      <small>
                        Illustration du jeu sélectionné
                      </small>
                    </span>

                    <span
                      className={`switch ${
                        prefs.backgrounds ? "on" : ""
                      }`}
                    />
                  </button>

                  <button
                    data-pad
                    onClick={() =>
                      setPrefs((previous) => ({
                        ...previous,
                        motion: !previous.motion,
                      }))
                    }
                  >
                    <span>
                      Animations
                      <small>
                        Démarrage et transitions
                      </small>
                    </span>

                    <span
                      className={`switch ${
                        prefs.motion ? "on" : ""
                      }`}
                    />
                  </button>

                  <button
                    data-pad
                    onClick={() =>
                      void call("system_action", {
                        action: "sound",
                      })
                    }
                  >
                    <Icon name="sound" />

                    <span>
                      Audio
                      <small>
                        Ouvrir les réglages Windows
                      </small>
                    </span>
                  </button>

                  <button
                    data-pad
                    onClick={() =>
                      void call("system_action", {
                        action: "network",
                      })
                    }
                  >
                    <Icon name="network" />

                    <span>
                      Réseau
                      <small>
                        Ouvrir les réglages Windows
                      </small>
                    </span>
                  </button>

                  <button
                    data-pad
                    disabled={loading}
                    onClick={() => void refresh()}
                  >
                    <Icon name="library" />

                    <span>
                      {loading
                        ? "Actualisation…"
                        : "Actualiser la bibliothèque"}

                      <small>
                        Relire les jeux installés
                      </small>
                    </span>
                  </button>

                  <button data-pad onClick={() => setPrefs((previous) => ({ ...previous, sounds: previous.sounds === false }))}>
                    <Icon name="sound" />
                    <span>Sons de l'interface<small>Déplacement, validation et retour</small></span>
                    <span className={`switch ${prefs.sounds !== false ? "on" : ""}`} />
                  </button>
                  <button data-pad onClick={() => setModal("exit")}><Icon name="close" /><span>Code de sortie<small>Configurer ou déverrouiller la sortie</small></span></button>
                  <p className="settings-note">
                    {controller
                      ? "Manette connectée · A valider, B revenir"
                      : "Manette : appuie sur un bouton pour la détecter."}
                  </p>

                  {warnings.map((warning, index) => (
                    <p
                      className="warning"
                      key={index}
                    >
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              {modal === "power" && (
                confirmPower ? (
                  <div className="confirmation">
                    <p>
                      {confirmPower === "shutdown"
                        ? "Éteindre le PC maintenant ?"
                        : "Redémarrer le PC maintenant ?"}
                    </p>

                    <p className="muted">
                      Enregistre tes documents
                      avant de continuer.
                    </p>

                    <div>
                      <button
                        data-pad
                        className="soft-button"
                        onClick={() =>
                          setConfirmPower(null)
                        }
                      >
                        Annuler
                      </button>

                      <button
                        data-pad
                        className="danger-button"
                        onClick={() =>
                          void call("system_action", {
                            action: confirmPower,
                          })
                        }
                      >
                        {confirmPower === "shutdown"
                          ? "Éteindre"
                          : "Redémarrer"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="settings-list">
                    <button
                      data-pad
                      onClick={() => {
                        dismiss();

                        void call("window_action", {
                          action: "desktop",
                        });
                      }}
                    >
                      <Icon name="desktop" />

                      <span>
                        Retour au bureau
                        <small>
                          Réduire Raye Square
                        </small>
                      </span>
                    </button>

                    <button
                      data-pad
                      onClick={() =>
                        void call("window_action", {
                          action: "close",
                        })
                      }
                    >
                      <Icon name="close" />
                      <span>Quitter l'application</span>
                    </button>

                    <button
                      data-pad
                      onClick={() =>
                        setConfirmPower("restart")
                      }
                    >
                      <Icon name="power" />
                      <span>Redémarrer le PC</span>
                    </button>

                    <button
                      data-pad
                      onClick={() =>
                        setConfirmPower("shutdown")
                      }
                    >
                      <Icon name="power" />
                      <span>Éteindre le PC</span>
                    </button>
                  </div>
                )
              )}

              {modal === "keyboard" && (
                <>
                  <div className="keyboard-value">
                    {query || "Nom du jeu…"}
                  </div>

                  <div className="virtual-keyboard">
                    {
                      "AZERTYUIOPQSDFGHJKLMWXCVBN0123456789"
                        .split("")
                        .map((letter) => (
                          <button
                            data-pad
                            key={letter}
                            onClick={() =>
                              setQuery(
                                (text) =>
                                  text +
                                  letter.toLowerCase(),
                              )
                            }
                          >
                            {letter}
                          </button>
                        ))
                    }
                  </div>

                  <div className="keyboard-actions">
                    <button
                      data-pad
                      className="soft-button"
                      onClick={() =>
                        setQuery(
                          (text) => text.slice(0, -1),
                        )
                      }
                    >
                      Effacer
                    </button>

                    <button
                      data-pad
                      className="soft-button"
                      onClick={() =>
                        setQuery((text) => text + " ")
                      }
                    >
                      Espace
                    </button>

                    <button
                      data-pad
                      className="play-button"
                      onClick={dismiss}
                    >
                      Terminé
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}

export default App;





