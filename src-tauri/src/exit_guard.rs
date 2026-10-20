use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf, sync::Mutex, time::{Duration, Instant}};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct Credential { version: u8, salt: [u8; 32], digest: [u8; 32] }
#[derive(Default)]
struct Attempts { failures: u8, locked_until: Option<Instant> }
static ATTEMPTS: Mutex<Attempts> = Mutex::new(Attempts { failures: 0, locked_until: None });

fn valid_pin(pin: &str) -> bool { pin.len() == 6 && pin.bytes().all(|b| b.is_ascii_digit()) }
fn location(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|p| p.join("exit-lock.json")).map_err(|e| e.to_string())
}
fn read(path: &PathBuf) -> Result<Option<Credential>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let record: Credential = serde_json::from_slice(&bytes).map_err(|_| "Le fichier du code de sortie est endommagé.".to_string())?;
            if record.version != 1 { return Err("Format du code de sortie inconnu.".into()); }
            Ok(Some(record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(handle: *mut std::ffi::c_void, buffer: *mut u8, size: u32, flags: u32) -> i32;
    fn BCryptOpenAlgorithmProvider(handle: *mut *mut std::ffi::c_void, name: *const u16, provider: *const u16, flags: u32) -> i32;
    fn BCryptDeriveKeyPBKDF2(handle: *mut std::ffi::c_void, password: *const u8, password_size: u32, salt: *const u8, salt_size: u32, iterations: u64, output: *mut u8, size: u32, flags: u32) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: *mut std::ffi::c_void, flags: u32) -> i32;
}
fn derive(pin: &str, salt: &[u8; 32]) -> Result<[u8; 32], String> {
    let name: Vec<u16> = "SHA256\0".encode_utf16().collect();
    let mut handle = std::ptr::null_mut();
    let mut output = [0; 32];
    unsafe {
        if BCryptOpenAlgorithmProvider(&mut handle, name.as_ptr(), std::ptr::null(), 8) < 0 {
            return Err("Protection du code indisponible.".into());
        }
        let result = BCryptDeriveKeyPBKDF2(handle, pin.as_ptr(), pin.len() as u32, salt.as_ptr(), 32, 210_000, output.as_mut_ptr(), 32, 0);
        BCryptCloseAlgorithmProvider(handle, 0);
        if result < 0 { return Err("Protection du code indisponible.".into()); }
    }
    Ok(output)
}
fn same(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}
fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Cette action appartient à l'accueil.".into()) }
}
#[tauri::command]
pub fn exit_code_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    check_window(&window)?; Ok(read(&location(&app)?)?.is_some())
}
#[tauri::command]
pub async fn exit_code_create(app: tauri::AppHandle, window: tauri::WebviewWindow, pin: String) -> Result<(), String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if !valid_pin(&pin) { return Err("Choisis un code de six chiffres.".into()); }
        let _lock = ATTEMPTS.lock().map_err(|_| "Protection indisponible.".to_string())?;
        let path = location(&app)?;
        if read(&path)?.is_some() { return Err("Un code de sortie existe déjà.".into()); }
        let mut salt = [0; 32];
        if unsafe { BCryptGenRandom(std::ptr::null_mut(), salt.as_mut_ptr(), 32, 2) } < 0 { return Err("Génération du code indisponible.".into()); }
        let record = Credential { version: 1, salt, digest: derive(&pin, &salt)? };
        fs::create_dir_all(path.parent().ok_or("Dossier de configuration manquant.")?).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
        let result = file.write_all(&serde_json::to_vec(&record).map_err(|e| e.to_string())?).and_then(|_| file.sync_all());
        drop(file);
        if let Err(error) = result { let _ = fs::remove_file(&path); return Err(error.to_string()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn exit_code_quit(app: tauri::AppHandle, window: tauri::WebviewWindow, pin: String) -> Result<(), String> {
    check_window(&window)?;
    let verify_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut attempts = ATTEMPTS.lock().map_err(|_| "Protection indisponible.".to_string())?;
        if let Some(until) = attempts.locked_until {
            if until > Instant::now() { return Err("Trop d'essais. Attends 30 secondes.".into()); }
            attempts.failures = 0; attempts.locked_until = None;
        }
        let record = read(&location(&verify_app)?)?.ok_or("Crée d'abord le code de sortie.")?;
        if !valid_pin(&pin) || !same(&derive(&pin, &record.salt)?, &record.digest) {
            attempts.failures += 1;
            if attempts.failures >= 5 { attempts.locked_until = Some(Instant::now() + Duration::from_secs(30)); }
            return Err("Code incorrect.".into());
        }
        attempts.failures = 0;
        Ok(())
    }).await.map_err(|e| e.to_string())??;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn pin_validation() { assert!(valid_pin("123456")); assert!(!valid_pin("12345")); assert!(!valid_pin("12a456")); assert!(!valid_pin("１２３")); }
    #[test] fn salted_derivation() {
        let first = derive("123456", &[1; 32]).unwrap();
        assert!(same(&first, &derive("123456", &[1; 32]).unwrap()));
        assert!(!same(&first, &derive("123456", &[2; 32]).unwrap()));
        assert!(!same(&first, &derive("123457", &[1; 32]).unwrap()));
    }
}
