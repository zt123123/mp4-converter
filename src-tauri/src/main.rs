#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod converter;

use converter::{check_ffmpeg, convert_video, delete_file, get_video_info, VideoInfo};
use tauri::Emitter;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    conversions: Mutex<std::collections::HashMap<String, bool>>,
}

#[tauri::command]
async fn cmd_check_ffmpeg() -> Result<bool, String> {
    check_ffmpeg().await
}

#[tauri::command]
async fn cmd_get_video_info(path: String) -> Result<VideoInfo, String> {
    get_video_info(&path).await
}

#[tauri::command]
async fn cmd_convert_video(
    input_path: String,
    output_dir: String,
    task_id: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    {
        let mut conversions = state.conversions.lock().unwrap();
        conversions.insert(task_id.clone(), true);
    }

    let task_id_clone = task_id.clone();

    let result = convert_video(&input_path, &output_dir, &task_id, move |progress| {
        let _ = window.emit(&format!("conversion-progress-{}", task_id_clone), progress);
    })
    .await;

    {
        let mut conversions = state.conversions.lock().unwrap();
        conversions.remove(&task_id);
    }

    result
}

#[tauri::command]
async fn cmd_cancel_conversion(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut conversions = state.conversions.lock().unwrap();
    conversions.remove(&task_id);
    Ok(())
}

#[tauri::command]
async fn cmd_delete_file(path: String) -> Result<(), String> {
    delete_file(&path).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            conversions: Mutex::new(std::collections::HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            cmd_check_ffmpeg,
            cmd_get_video_info,
            cmd_convert_video,
            cmd_cancel_conversion,
            cmd_delete_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
