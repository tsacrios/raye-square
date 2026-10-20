#[cfg(windows)]
mod quick_menu;
mod exit_guard;
use tauri::Emitter;
use tauri::Manager;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const STEAM: &str = r"C:\Program Files (x86)\Steam";

#[derive(Serialize)]
struct SteamGame {
    app_id: String,
    name: String,
    library: String,
}

#[derive(Serialize)]
struct Library {
    games: Vec<SteamGame>,
    warnings: Vec<String>,
}

// Lecture des chaînes entre guillemets dans les fichiers Steam.
fn quoted(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut chars = line.chars();

    while let Some(character) = chars.next() {
        if character != '"' {
            continue;
        }

        let mut text = String::new();

        while let Some(character) = chars.next() {
            match character {
                '"' => break,
                '\\' => {
                    if let Some(next) = chars.next() {
                        text.push(next);
                    }
                }
                _ => text.push(character),
            }
        }

        values.push(text);
    }

    values
}

fn value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let parts = quoted(line);

        if parts.len() >= 2 && parts[0] == key {
            Some(parts[1].clone())
        } else {
            None
        }
    })
}

fn libraries() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from(STEAM),
        PathBuf::from(r"D:\SteamLibrary"),
    ];

    let config = Path::new(STEAM)
        .join("steamapps")
        .join("libraryfolders.vdf");

    if let Ok(content) = fs::read_to_string(config) {
        for line in content.lines() {
            let parts = quoted(line);

            if parts.len() >= 2 && parts[0] == "path" {
                paths.push(PathBuf::from(&parts[1]));
            }
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

#[tauri::command]
fn get_steam_games() -> Library {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();

    for root in libraries() {
        let folder = root.join("steamapps");

        if !folder.exists() {
            continue;
        }

        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!(
                    "{} : {error}",
                    folder.display()
                ));
                continue;
            }
        };

        for entry in entries.flatten() {
            let filename = entry
                .file_name()
                .to_string_lossy()
                .into_owned();

            if !filename.starts_with("appmanifest_")
                || !filename.ends_with(".acf")
            {
                continue;
            }

            let content = match fs::read_to_string(entry.path()) {
                Ok(content) => content,
                Err(error) => {
                    warnings.push(format!("{filename} : {error}"));
                    continue;
                }
            };

            let app_id = value(&content, "appid");
            let name = value(&content, "name");
            let install_dir = value(&content, "installdir");

            if let (Some(id), Some(name), Some(dir)) =
                (app_id, name, install_dir)
            {
                let complete = value(&content, "StateFlags")
                    .and_then(|flags| flags.parse::<u32>().ok())
                    .map(|flags| flags & 4 != 0)
                    .unwrap_or(false);

                if id == "228980"
                    || id.parse::<u32>().is_err()
                    || !complete
                    || !folder.join("common").join(dir).is_dir()
                {
                    continue;
                }

                if seen.insert(id.clone()) {
                    games.push(SteamGame {
                        app_id: id,
                        name,
                        library: root.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }

    games.sort_by_key(|game| game.name.to_lowercase());

    Library { games, warnings }
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.parse::<u32>().is_err() {
        return Err("Identifiant Steam invalide.".into());
    }

    let library = get_steam_games();

    if !library.games.iter().any(|game| game.app_id == id) {
        return Err(
            "Ce jeu n'est plus installé. Actualise ta bibliothèque."
                .into(),
        );
    }

    Ok(())
}

fn spawn(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args);

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Impossible d'ouvrir {} : {error}",
                program.display()
            )
        })
}

// Surveillance en lecture seule de l'état indiqué par Steam.
#[derive(Default)]
struct GameSession(std::sync::Mutex<Option<String>>);

#[derive(Default)]
struct SessionTracker {
    seen_running: bool,
    stopped_samples: u8,
}

impl SessionTracker {
    fn observe(&mut self, running: bool) -> bool {
        if running {
            self.seen_running = true;
            self.stopped_samples = 0;
        } else if self.seen_running {
            self.stopped_samples += 1;
        }
        self.seen_running && self.stopped_samples >= 5
    }

    fn unknown(&mut self) {
        // Une erreur de lecture ne signifie pas que le jeu est fermé.
        self.stopped_samples = 0;
    }
}

#[cfg(windows)]
fn steam_game_running(app_id: &str) -> Result<bool, String> {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: *mut c_void,
            subkey: *const u16,
            name: *const u16,
            flags: u32,
            value_type: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    let key: Vec<u16> = format!(r"Software\Valve\Steam\Apps\{app_id}")
        .encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = "Running".encode_utf16().chain(Some(0)).collect();
    let mut failure = None;
    for view in [0x00020000u32, 0x00010000u32] {
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // HKCU est une constante Windows signée étendue à la taille d'un pointeur.
        // Les chaînes UTF-16 et le tampon DWORD restent valides pendant l'appel.
        let result = unsafe {
            RegGetValueW(
                (-2147483647isize) as *mut c_void,
                key.as_ptr(), name.as_ptr(), 0x10 | view,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(), &mut size,
            )
        };
        match result {
            0 => return Ok(value != 0),
            2 | 3 => {}, // Steam n'a pas encore créé la valeur.
            code => failure = Some(code),
        }
    }
    match failure {
        Some(code) => Err(format!("Lecture de l'état Steam impossible ({code}).")),
        None => Ok(false),
    }
}

#[cfg(not(windows))]
fn steam_game_running(_app_id: &str) -> Result<bool, String> {
    Err("Le retour automatique nécessite Windows.".into())
}

#[tauri::command]
fn launch_game(
    app_id: String,
    window: tauri::WebviewWindow,
    session: tauri::State<'_, std::sync::Arc<GameSession>>,
) -> Result<(), String> {
    valid_id(&app_id)?;
    let shared = session.inner().clone();
    let mut active = shared.0.lock().map_err(|_| "Suivi du jeu indisponible.")?;
    if active.is_some() {
        return Err("Un jeu est déjà en cours de lancement ou en cours d'exécution.".into());
    }
    let steam = Path::new(STEAM).join("steam.exe");
    spawn(&steam, &["-applaunch", &app_id])?;
    *active = Some(app_id.clone());
    drop(active);

    std::thread::spawn(move || {
        use tauri::Emitter;
        let started = std::time::Instant::now();
        let mut tracker = SessionTracker::default();
        let mut errors = 0u8;
        let completed = loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            match steam_game_running(&app_id) {
                Ok(running) => {
                    errors = 0;
                    if tracker.observe(running) { break true; }
                }
                Err(_) => {
                    tracker.unknown();
                    errors += 1;
                    if errors >= 10 { break false; }
                }
            }
            if !tracker.seen_running && started.elapsed().as_secs() >= 300 {
                // Ne pas reprendre le premier plan sur la base d'un simple délai.
                break false;
            }
        };
        if let Ok(mut active) = shared.0.lock() {
            *active = None;
        }
        if completed {
            #[cfg(windows)]
            quick_menu::game_finished(window.app_handle());
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            let _ = window.emit("game-ended", app_id);
        } else {
            let _ = window.emit("game-monitor-unavailable", app_id);
        }
    });
    Ok(())
}

#[cfg(test)]
mod session_tests {
    use super::SessionTracker;

    #[test]
    fn never_returns_before_starting() {
        let mut tracker = SessionTracker::default();
        for _ in 0..300 { assert!(!tracker.observe(false)); }
    }

    #[test]
    fn requires_five_stopped_samples() {
        let mut tracker = SessionTracker::default();
        assert!(!tracker.observe(true));
        for _ in 0..4 { assert!(!tracker.observe(false)); }
        assert!(tracker.observe(false));
    }

    #[test]
    fn launcher_transition_does_not_end_session() {
        let mut tracker = SessionTracker::default();
        tracker.observe(true);
        for _ in 0..4 { assert!(!tracker.observe(false)); }
        assert!(!tracker.observe(true));
        for _ in 0..4 { assert!(!tracker.observe(false)); }
        assert!(tracker.observe(false));
    }

    #[test]
    fn read_failure_is_not_an_exit() {
        let mut tracker = SessionTracker::default();
        tracker.observe(true);
        for _ in 0..4 { assert!(!tracker.observe(false)); }
        tracker.unknown();
        for _ in 0..4 { assert!(!tracker.observe(false)); }
        assert!(tracker.observe(false));
    }
}

#[tauri::command]
fn open_steam(
    page: String,
    app_id: Option<String>,
) -> Result<(), String> {
    let uri = match page.as_str() {
        "store" => match app_id {
            Some(id) => {
                valid_id(&id)?;
                format!("steam://store/{id}")
            }
            None => "steam://store".into(),
        },
        "downloads" => "steam://nav/downloads".into(),
        _ => return Err("Page Steam inconnue.".into()),
    };

    let steam = Path::new(STEAM).join("steam.exe");
    spawn(&steam, &[&uri])
}

fn find_image(
    folder: &Path,
    needle: &str,
    prefix: Option<&str>,
    depth: u8,
) -> Option<PathBuf> {
    let mut entries: Vec<_> =
        fs::read_dir(folder).ok()?.flatten().collect();

    entries.sort_by_key(|entry| entry.file_name());

    for entry in &entries {
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let name = entry
            .file_name()
            .to_string_lossy()
            .to_lowercase();

        let is_image = name.ends_with(".jpg")
            || name.ends_with(".png")
            || name.ends_with(".webp");

        let matches_prefix = prefix
            .map(|prefix| name.starts_with(prefix))
            .unwrap_or(true);

        if is_image && name.contains(needle) && matches_prefix {
            return Some(path);
        }
    }

    if depth > 0 {
        for entry in entries {
            if entry.path().is_dir() {
                if let Some(path) = find_image(
                    &entry.path(),
                    needle,
                    None,
                    depth - 1,
                ) {
                    return Some(path);
                }
            }
        }
    }

    None
}

#[tauri::command]
fn get_artwork(
    app_id: String,
    kind: String,
) -> Result<Option<Vec<u8>>, String> {
    if app_id.parse::<u32>().is_err() {
        return Err("Identifiant invalide.".into());
    }

    let needle = match kind.as_str() {
        "cover" => "library_600x900",
        "hero" => "library_hero",
        "logo" => "logo",
        _ => return Err("Image inconnue.".into()),
    };

    let cache = Path::new(STEAM)
        .join("appcache")
        .join("librarycache");

    let path = find_image(
        &cache.join(&app_id),
        needle,
        None,
        3,
    )
    .or_else(|| {
        find_image(
            &cache,
            needle,
            Some(&format!("{app_id}_")),
            0,
        )
    });

    match path {
        Some(path) => {
            let size = fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len();

            if size > 20_000_000 {
                return Ok(None);
            }

            fs::read(path)
                .map(Some)
                .map_err(|error| error.to_string())
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn window_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    let result = match action.as_str() {
        "fullscreen" => window
            .is_fullscreen()
            .and_then(|fullscreen| {
                window.set_fullscreen(!fullscreen)
            }),
        "desktop" => window.minimize(),
        "close" => {
            window.emit("exit-request", ()).map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => return Err("Action inconnue.".into()),
    };

    result.map_err(|error| error.to_string())
}

#[tauri::command]
fn system_action(action: String) -> Result<(), String> {
    match action.as_str() {
        "sound" => spawn(
            Path::new("explorer.exe"),
            &["ms-settings:sound"],
        ),
        "network" => spawn(
            Path::new("explorer.exe"),
            &["ms-settings:network"],
        ),
        "shutdown" => spawn(
            Path::new("shutdown.exe"),
            &["/s", "/t", "0"],
        ),
        "restart" => spawn(
            Path::new("shutdown.exe"),
            &["/r", "/t", "0"],
        ),
        _ => Err("Action inconnue.".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(std::sync::Arc::new(GameSession::default()))
        .manage(std::sync::Arc::new(quick_menu::QuickState::default()))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.emit("exit-request", ());
                }
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            if let Err(error) = quick_menu::initialize(app.handle()) {
                eprintln!("Menu rapide indisponible : {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_steam_games,
            launch_game,
            open_steam,
            get_artwork,
            window_action,
            system_action,
            ui_sound,
            exit_guard::exit_code_status,
            exit_guard::exit_code_create,
            exit_guard::exit_code_quit,
            quick_menu::quick_status,
            quick_menu::quick_volume,
            quick_menu::quick_action,
        ])
        .run(tauri::generate_context!())
        .expect("Impossible de démarrer Console Windows");
}

// Les buffers restent vivants pendant la lecture asynchrone de Windows.
fn make_ui_wave(frequency: f64, duration: f64, rising: bool) -> Vec<u8> {
    let rate = 22050u32;
    let count = (duration * rate as f64) as u32;
    let size = count * 2;
    let mut wave = Vec::with_capacity(44 + size as usize);
    wave.extend_from_slice(b"RIFF"); wave.extend_from_slice(&(36 + size).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt "); wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes()); wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&rate.to_le_bytes()); wave.extend_from_slice(&(rate * 2).to_le_bytes());
    wave.extend_from_slice(&2u16.to_le_bytes()); wave.extend_from_slice(&16u16.to_le_bytes());
    wave.extend_from_slice(b"data"); wave.extend_from_slice(&size.to_le_bytes());
    for index in 0..count {
        let t = index as f64 / rate as f64;
        let progress = t / duration;
        let envelope = (t / 0.008).min(1.0) * (1.0 - progress).powi(2);
        let sweep = if rising { 180.0 } else { -90.0 };
        let phase = std::f64::consts::TAU * (frequency * t + sweep * t * t / (2.0 * duration));
        let sample = (phase.sin() * envelope * 1500.0) as i16;
        wave.extend_from_slice(&sample.to_le_bytes());
    }
    wave
}

#[tauri::command]
fn ui_sound(kind: String) -> Result<(), String> {
    let index = match kind.as_str() { "move" => 0, "accept" => 1, "back" => 2, _ => return Err("Son inconnu".into()) };
    #[cfg(windows)]
    {
        #[link(name = "winmm")]
        extern "system" { fn PlaySoundW(sound: *const u16, module: *mut std::ffi::c_void, flags: u32) -> i32; }
        static SOUNDS: std::sync::OnceLock<[Vec<u8>; 3]> = std::sync::OnceLock::new();
        let sounds = SOUNDS.get_or_init(|| [make_ui_wave(600.0, 0.045, false), make_ui_wave(740.0, 0.11, true), make_ui_wave(480.0, 0.085, false)]);
        // SND_MEMORY | SND_ASYNC | SND_NODEFAULT : uniquement nos sons.
        unsafe { PlaySoundW(sounds[index].as_ptr().cast(), std::ptr::null_mut(), 0x0004 | 0x0001 | 0x0002); }
    }
    #[cfg(not(windows))]
    let _ = index;
    Ok(())
}


