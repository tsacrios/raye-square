use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering}, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use windows::{
    core::{w, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, Endpoints::IAudioEndpointVolume},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED},
            LibraryLoader::GetModuleHandleW,
            Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{Input::*, WindowsAndMessaging::*},
    },
};

const LABEL: &str = "quick-menu";

#[derive(Default)]
pub struct QuickState {
    open: AtomicBool,
    previous: AtomicIsize,
    previous_pid: AtomicU64,
    report_time: AtomicU64,
    error: Mutex<Option<String>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Buttons { ps: bool, accept: bool, back: bool, direction: u8 }

// USB uniquement : rapport complet 0x01 de 64 octets.
// Aucun rapport de sortie n'est envoyé à la manette.
fn decode_usb(packet: &[u8]) -> Option<Buttons> {
    if packet.len() != 64 || packet[0] != 0x01 { return None; }
    let direction = match packet[8] & 0x0f {
        0 | 1 | 7 => 1,
        3..=5 => 2,
        6 => 3,
        2 => 4,
        _ if packet[2] < 55 => 1,
        _ if packet[2] > 200 => 2,
        _ if packet[1] < 55 => 3,
        _ if packet[1] > 200 => 4,
        _ => 0,
    };
    Some(Buttons {
        ps: packet[10] & 1 != 0,
        accept: packet[8] & 0x20 != 0,
        back: packet[8] & 0x40 != 0,
        direction,
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html?quick-menu=1".into()))
        .title("Raye Square · Menu rapide")
        .visible(false).focused(false).decorations(false).transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .always_on_top(true).skip_taskbar(true).shadow(false).resizable(false)
        .inner_size(1280.0, 720.0).build()?;
    let close_app = app.clone();
    menu.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_menu(&close_app, true);
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = raw_loop(&app) {
            if let Ok(mut slot) = app.state::<Arc<QuickState>>().error.lock() {
                *slot = Some(error);
            }
        }
    });
    Ok(())
}

fn previous_window(state: &QuickState) -> Option<HWND> {
    let raw = state.previous.load(Ordering::SeqCst);
    if raw == 0 { return None; }
    let hwnd = HWND(raw as *mut _);
    let mut pid = 0;
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() { return None; }
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid == 0 || pid as u64 != state.previous_pid.load(Ordering::SeqCst) { return None; }
    Some(hwnd)
}

fn close_menu(app: &tauri::AppHandle, restore: bool) -> Result<(), String> {
    let state = app.state::<Arc<QuickState>>();
    state.open.store(false, Ordering::SeqCst);
    let _ = app.emit("quick-visibility", false);
    app.get_webview_window(LABEL).ok_or("Menu indisponible.")?.hide().map_err(|e| e.to_string())?;
    if restore {
        if let Some(hwnd) = previous_window(&state) {
            unsafe { let _ = SetForegroundWindow(hwnd); }
        }
    }
    Ok(())
}

fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<QuickState>>();
    if state.open.load(Ordering::SeqCst) { return close_menu(app, true); }
    let hwnd = unsafe { GetForegroundWindow() };
    if !hwnd.0.is_null() {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
        // Ne pas remplacer le dernier jeu mémorisé par nos propres fenêtres.
        if pid != std::process::id() {
            state.previous.store(hwnd.0 as isize, Ordering::SeqCst);
            state.previous_pid.store(pid as u64, Ordering::SeqCst);
        }
    }
    let menu = app.get_webview_window(LABEL).ok_or("Menu indisponible.")?;
    let mut placed = false;
    if let Some(hwnd) = previous_window(&state) {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let available = unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info).as_bool() };
        if available {
            let bounds = info.rcMonitor;
            menu.set_position(tauri::PhysicalPosition::new(bounds.left, bounds.top)).map_err(|e| e.to_string())?;
            menu.set_size(tauri::PhysicalSize::new((bounds.right - bounds.left) as u32, (bounds.bottom - bounds.top) as u32)).map_err(|e| e.to_string())?;
            placed = true;
        }
    }
    if !placed {
        if let Some(monitor) = app.get_webview_window("main").and_then(|w| w.current_monitor().ok().flatten()) {
            menu.set_position(*monitor.position()).map_err(|e| e.to_string())?;
            menu.set_size(*monitor.size()).map_err(|e| e.to_string())?;
        }
    }
    state.open.store(true, Ordering::SeqCst);
    let _ = app.emit("quick-visibility", true);
    if let Err(error) = menu.show().and_then(|_| menu.set_focus()) {
        state.open.store(false, Ordering::SeqCst);
        let _ = app.emit("quick-visibility", false);
        let _ = menu.hide();
        return Err(error.to_string());
    }
    if let Ok(hwnd) = menu.hwnd() {
        // Demande normale d'activation ; Windows peut la refuser pour certains jeux.
        unsafe { let _ = SetForegroundWindow(HWND(hwnd.0)); }
    }
    let _ = menu.emit("quick-open", ());
    Ok(())
}

pub fn game_finished(app: &tauri::AppHandle) {
    let _ = close_menu(app, false);
    let state = app.state::<Arc<QuickState>>();
    state.previous.store(0, Ordering::SeqCst);
    state.previous_pid.store(0, Ordering::SeqCst);
}

#[derive(Serialize)]
pub struct Status {
    game: Option<String>,
    controller: bool,
    input_error: Option<String>,
    volume: Option<u8>,
    audio_error: Option<String>,
}

#[tauri::command]
pub async fn quick_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Status, String> {
    if window.label() != LABEL { return Err("Fenêtre non autorisée.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let active = app.state::<Arc<super::GameSession>>().0.lock()
            .map_err(|_| "Suivi indisponible.")?.clone();
        let game = active.and_then(|id| super::get_steam_games().games.into_iter()
            .find(|game| game.app_id == id).map(|game| game.name));
        let state = app.state::<Arc<QuickState>>();
        let controller = now_ms().saturating_sub(state.report_time.load(Ordering::Relaxed)) < 5000;
        let input_error = state.error.lock().ok().and_then(|e| e.clone());
        let audio = audio_volume(None);
        Ok(Status { game, controller, input_error, volume: audio.as_ref().ok().copied(), audio_error: audio.err() })
    }).await.map_err(|e| e.to_string())?
}

fn audio_volume(delta: Option<i32>) -> Result<u8, String> {
    struct ComGuard(bool);
    impl Drop for ComGuard { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize(); } } } }
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // Un appartement COM déjà initialisé peut être utilisé sans le désinitialiser.
    let initialized = hr.is_ok();
    if !initialized && hr.0 != 0x80010106u32 as i32 { return Err(hr.to_string()); }
    let _guard = ComGuard(initialized);
    let result: windows::core::Result<u8> = (|| unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        let current = volume.GetMasterVolumeLevelScalar()?;
        if let Some(delta) = delta {
            volume.SetMasterVolumeLevelScalar((current + delta as f32 / 100.0).clamp(0.0, 1.0), std::ptr::null())?;
        }
        Ok((volume.GetMasterVolumeLevelScalar()? * 100.0).round() as u8)
    })();
    result.map_err(|e| format!("Sortie audio indisponible : {e}"))
}

#[tauri::command]
pub async fn quick_volume(window: tauri::WebviewWindow, delta: i32) -> Result<u8, String> {
    if window.label() != LABEL || ![-5, 5].contains(&delta) { return Err("Réglage invalide.".into()); }
    tauri::async_runtime::spawn_blocking(move || audio_volume(Some(delta))).await.map_err(|e| e.to_string())?
}

fn game_window(app: &tauri::AppHandle) -> Result<HWND, String> {
    let active = app.state::<Arc<super::GameSession>>().0.lock()
        .map_err(|_| "Suivi indisponible.")?.clone().ok_or("Aucun jeu lancé depuis Raye Square.")?;
    let hwnd = previous_window(&app.state::<Arc<QuickState>>()).ok_or("Fenêtre du jeu introuvable.")?;
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(|e| e.to_string())?;
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let result = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), PWSTR(buffer.as_mut_ptr()), &mut length) };
    unsafe { let _ = CloseHandle(handle); }
    result.map_err(|e| e.to_string())?;
    let executable = String::from_utf16_lossy(&buffer[..length as usize]).to_lowercase();
    for root in super::libraries() {
        let manifest = root.join("steamapps").join(format!("appmanifest_{active}.acf"));
        if let Ok(content) = std::fs::read_to_string(manifest) {
            if let Some(dir) = super::value(&content, "installdir") {
                let base = format!("{}\\", root.join("steamapps").join("common").join(dir).to_string_lossy()).to_lowercase();
                if executable.starts_with(&base) { return Ok(hwnd); }
            }
        }
    }
    Err("Cette fenêtre n'est pas celle du jeu suivi. Quitte depuis le menu du jeu.".into())
}

#[tauri::command]
pub fn quick_action(app: tauri::AppHandle, window: tauri::WebviewWindow, action: String, confirmed: bool) -> Result<(), String> {
    if window.label() != LABEL { return Err("Fenêtre non autorisée.".into()); }
    match action.as_str() {
        "resume" => close_menu(&app, true),
        "home" => {
            close_menu(&app, false)?;
            let main = app.get_webview_window("main").ok_or("Accueil indisponible.")?;
            main.emit("quick-home", ()).map_err(|e| e.to_string())?;
            main.show().and_then(|_| main.unminimize()).and_then(|_| main.set_focus()).map_err(|e| e.to_string())
        }
        "quit" if confirmed => {
            let hwnd = game_window(&app)?;
            unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|e| e.to_string())?;
            close_menu(&app, true)
        }
        "shutdown" | "restart" if confirmed => super::system_action(action),
        _ => Err("Action inconnue ou confirmation manquante.".into()),
    }
}

struct RawContext {
    app: tauri::AppHandle,
    accepted: HashMap<isize, bool>,
    buttons: HashMap<isize, Buttons>,
    direction_at: Instant,
    repeat: bool,
    toggle_at: Instant,
}
thread_local! { static RAW: RefCell<Option<RawContext>> = const { RefCell::new(None) }; }

fn process_packet(context: &mut RawContext, device: isize, packet: &[u8]) {
    let Some(current) = decode_usb(packet) else { return; };
    let state = context.app.state::<Arc<QuickState>>();
    state.report_time.store(now_ms(), Ordering::Relaxed);
    let previous = context.buttons.insert(device, current).unwrap_or_default();
    if current.ps && !previous.ps && context.toggle_at.elapsed() >= Duration::from_millis(300) {
        context.toggle_at = Instant::now();
        if let Err(error) = toggle(&context.app) {
            if let Ok(mut slot) = state.error.lock() { *slot = Some(error); }
        }
        return;
    }
    if !state.open.load(Ordering::SeqCst) { return; }
    let mut action = None;
    if current.back && !previous.back { action = Some("back"); }
    else if current.accept && !previous.accept { action = Some("accept"); }
    else if current.direction != 0 {
        let changed = current.direction != previous.direction;
        let interval = if context.repeat { 150 } else { 380 };
        if changed || context.direction_at.elapsed() >= Duration::from_millis(interval) {
            context.repeat = !changed;
            context.direction_at = Instant::now();
            action = Some(match current.direction { 1 => "up", 2 => "down", 3 => "left", _ => "right" });
        }
    } else { context.repeat = false; }
    if let Some(action) = action {
        if let Some(menu) = context.app.get_webview_window(LABEL) { let _ = menu.emit("quick-input", action); }
    }
}

unsafe fn raw_input(context: &mut RawContext, lparam: LPARAM) {
    let mut size = 0u32;
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    let handle = HRAWINPUT(lparam.0 as *mut _);
    if GetRawInputData(handle, RID_INPUT, None, &mut size, header_size) == u32::MAX
        || size < header_size + 8 || size > 65536 { return; }
    // Un tampon u64 fournit l'alignement des structures Windows, même en 64 bits.
    let mut buffer = vec![0u64; (size as usize + 7) / 8];
    let copied = GetRawInputData(handle, RID_INPUT, Some(buffer.as_mut_ptr().cast()), &mut size, header_size);
    if copied == u32::MAX || copied < header_size + 8 { return; }
    let header = std::ptr::read_unaligned(buffer.as_ptr().cast::<RAWINPUTHEADER>());
    if header.dwType != RIM_TYPEHID.0 { return; }
    let device = header.hDevice.0 as isize;
    let accepted = *context.accepted.entry(device).or_insert_with(|| {
        let mut info = RID_DEVICE_INFO { cbSize: std::mem::size_of::<RID_DEVICE_INFO>() as u32, ..Default::default() };
        let mut size = info.cbSize;
        if GetRawInputDeviceInfoW(Some(header.hDevice), RIDI_DEVICEINFO, Some((&mut info as *mut RID_DEVICE_INFO).cast()), &mut size) == u32::MAX { return false; }
        let hid = info.Anonymous.hid;
        info.dwType == RIM_TYPEHID && hid.dwVendorId == 0x054c && [0x0ce6, 0x0df2].contains(&hid.dwProductId)
    });
    if !accepted { return; }
    let bytes = std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), copied as usize);
    let offset = header_size as usize;
    let packet_size = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    let count = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
    if packet_size == 0 || count > 1024 { return; }
    let data = &bytes[offset + 8..];
    if packet_size.checked_mul(count).is_none_or(|length| length > data.len()) { return; }
    for packet in data.chunks_exact(packet_size).take(count) { process_packet(context, device, packet); }
}

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_INPUT {
        RAW.with(|slot| { if let Some(context) = slot.borrow_mut().as_mut() { raw_input(context, lparam); } });
    } else if message == WM_HOTKEY && wparam.0 == 0x5151 {
        RAW.with(|slot| { if let Some(context) = slot.borrow().as_ref() { let _ = toggle(&context.app); } });
    } else if message == WM_INPUT_DEVICE_CHANGE {
        RAW.with(|slot| {
            if let Some(context) = slot.borrow_mut().as_mut() {
                context.accepted.remove(&lparam.0);
                context.buttons.remove(&lparam.0);
            }
        });
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn raw_loop(app: &tauri::AppHandle) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_CONTROL, MOD_SHIFT, MOD_NOREPEAT};
    unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
        let class = WNDCLASSW { lpfnWndProc: Some(procedure), hInstance: HINSTANCE(module.0), lpszClassName: w!("RayeSquareDualSenseInput"), ..Default::default() };
        if RegisterClassW(&class) == 0 { return Err("Impossible d'initialiser la détection DualSense.".into()); }
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), class.lpszClassName, w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(class.hInstance), None).map_err(|e| e.to_string())?;
        RAW.with(|slot| *slot.borrow_mut() = Some(RawContext {
            app: app.clone(), accepted: HashMap::new(), buttons: HashMap::new(),
            direction_at: Instant::now(), repeat: false,
            toggle_at: Instant::now() - Duration::from_secs(1),
        }));
        let devices = [4, 5].map(|usage| RAWINPUTDEVICE {
            usUsagePage: 1, usUsage: usage, dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY, hwndTarget: hwnd,
        });
        RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32).map_err(|e| e.to_string())?;
        let _ = RegisterHotKey(Some(hwnd), 0x5151, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, 0x51);
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result == -1 { return Err("La détection manette s'est arrêtée.".into()); }
            if result == 0 { break; }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet() -> [u8; 64] { let mut p = [0u8; 64]; p[0] = 1; p[1] = 128; p[2] = 128; p[8] = 8; p }
    #[test] fn rejects_truncated_and_bluetooth() {
        assert!(decode_usb(&[1; 10]).is_none());
        let mut p = packet(); p[0] = 0x31; assert!(decode_usb(&p).is_none());
    }
    #[test] fn ps_is_distinct_from_touchpad_and_microphone() {
        let mut p = packet(); p[10] = 6; assert!(!decode_usb(&p).unwrap().ps);
        p[10] = 1; assert!(decode_usb(&p).unwrap().ps);
    }
    #[test] fn cross_and_circle_are_mapped_correctly() {
        let mut p = packet(); p[8] |= 0x20; assert!(decode_usb(&p).unwrap().accept); assert!(!decode_usb(&p).unwrap().back);
        p[8] = 0x48; assert!(decode_usb(&p).unwrap().back); assert!(!decode_usb(&p).unwrap().accept);
    }
    #[test] fn neutral_hat_and_centered_stick_do_not_move() { assert_eq!(decode_usb(&packet()).unwrap().direction, 0); }
    #[test] fn dpad_and_stick_work() {
        let mut p = packet(); p[8] = 6; assert_eq!(decode_usb(&p).unwrap().direction, 3);
        p[8] = 8; p[2] = 210; assert_eq!(decode_usb(&p).unwrap().direction, 2);
    }
}

