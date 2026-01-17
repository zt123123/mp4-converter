use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub path: String,
    pub filename: String,
    pub codec: String,
    pub audio_codec: String,
    pub container: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub bitrate: u64,
    pub needs_conversion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionProgress {
    pub task_id: String,
    pub progress: f64,
    pub status: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

/// Get the directory containing the bundled binaries
fn get_bundled_bin_dir() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;

    #[cfg(target_os = "macos")]
    {
        // On macOS, the binary is at App.app/Contents/MacOS/app-name
        // External binaries are at App.app/Contents/MacOS/
        exe_path.parent().map(|p| p.to_path_buf())
    }

    #[cfg(target_os = "windows")]
    {
        exe_path.parent().map(|p| p.to_path_buf())
    }

    #[cfg(target_os = "linux")]
    {
        exe_path.parent().map(|p| p.to_path_buf())
    }
}

/// Get the path to bundled ffmpeg binary
fn get_ffmpeg_path() -> String {
    if let Some(bin_dir) = get_bundled_bin_dir() {
        let bundled_path = bin_dir.join("ffmpeg");
        if bundled_path.exists() {
            return bundled_path.to_string_lossy().to_string();
        }
    }
    // Fallback to system ffmpeg
    "ffmpeg".to_string()
}

/// Get the path to bundled ffprobe binary
fn get_ffprobe_path() -> String {
    if let Some(bin_dir) = get_bundled_bin_dir() {
        let bundled_path = bin_dir.join("ffprobe");
        if bundled_path.exists() {
            return bundled_path.to_string_lossy().to_string();
        }
    }
    // Fallback to system ffprobe
    "ffprobe".to_string()
}

pub async fn check_ffmpeg() -> Result<bool, String> {
    // First try to use bundled ffmpeg
    let ffmpeg_path = get_ffmpeg_path();

    let output = Command::new(&ffmpeg_path)
        .arg("-version")
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => return Ok(true),
        _ => {}
    }

    // Fallback to system ffmpeg
    let output = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map_err(|e| format!("Failed to check ffmpeg: {}", e))?;

    Ok(output.status.success())
}

pub async fn get_video_info(path: &str) -> Result<VideoInfo, String> {
    let ffprobe_path = get_ffprobe_path();

    // Try bundled ffprobe first
    let output = Command::new(&ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .await;

    let output = match output {
        Ok(out) if out.status.success() => out,
        _ => {
            // Fallback to system ffprobe
            Command::new("ffprobe")
                .args([
                    "-v",
                    "quiet",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    path,
                ])
                .output()
                .await
                .map_err(|e| format!("Failed to get video info: {}", e))?
        }
    };

    if !output.status.success() {
        return Err("Failed to probe video file".to_string());
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let video_stream = json["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|s| s["codec_type"] == "video"))
        .ok_or("No video stream found")?;

    let audio_stream = json["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|s| s["codec_type"] == "audio"));

    let codec = video_stream["codec_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let audio_codec = audio_stream
        .and_then(|s| s["codec_name"].as_str())
        .unwrap_or("unknown")
        .to_string();

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;

    let format = &json["format"];
    let duration = format["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let bitrate = format["bit_rate"]
        .as_str()
        .and_then(|b| b.parse::<u64>().ok())
        .unwrap_or(0);

    let container = format["format_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let filename = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    // Check if needs conversion: must be H.264+AAC in MP4 container for mobile compatibility
    let is_mobile_compatible = codec == "h264"
        && audio_codec == "aac"
        && container.contains("mp4");

    Ok(VideoInfo {
        path: path.to_string(),
        filename,
        codec,
        audio_codec,
        container,
        duration,
        width,
        height,
        bitrate,
        needs_conversion: !is_mobile_compatible,
    })
}

/// Parse time string like "00:01:23.45" to seconds
fn parse_time_to_seconds(time_str: &str) -> f64 {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let hours: f64 = parts[0].parse().unwrap_or(0.0);
        let minutes: f64 = parts[1].parse().unwrap_or(0.0);
        let seconds: f64 = parts[2].parse().unwrap_or(0.0);
        hours * 3600.0 + minutes * 60.0 + seconds
    } else {
        0.0
    }
}

/// Get the number of CPU cores for multi-threading
fn get_thread_count() -> String {
    std::thread::available_parallelism()
        .map(|n| n.get().to_string())
        .unwrap_or_else(|_| "4".to_string())
}

pub async fn convert_video<F>(
    input_path: &str,
    output_dir: &str,
    task_id: &str,
    progress_callback: F,
) -> Result<String, String>
where
    F: Fn(ConversionProgress) + Send + Sync + 'static,
{
    let input_path_obj = Path::new(input_path);
    let stem = input_path_obj
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());

    let output_path = Path::new(output_dir).join(format!("{}_converted.mp4", stem));
    let output_path_str = output_path.to_string_lossy().to_string();

    // Get video info for progress calculation and smart conversion
    let info = get_video_info(input_path).await?;
    let duration = info.duration;
    let is_h264 = info.codec == "h264";
    let is_aac = info.audio_codec == "aac";

    // Send starting progress
    progress_callback(ConversionProgress {
        task_id: task_id.to_string(),
        progress: 0.0,
        status: "starting".to_string(),
        output_path: None,
        error: None,
    });

    let ffmpeg_path = get_ffmpeg_path();
    let task_id_owned = task_id.to_string();
    let output_path_for_callback = output_path_str.clone();
    let input_path_owned = input_path.to_string();
    let thread_count = get_thread_count();

    // Wrap callback in Arc for sharing
    let callback = Arc::new(progress_callback);
    let callback_clone = Arc::clone(&callback);

    // Run ffmpeg conversion with optimizations
    let mut cmd = Command::new(&ffmpeg_path);

    // Use multi-threading for decoding
    cmd.arg("-threads").arg(&thread_count)
        .arg("-y")                            // Overwrite output
        .arg("-i").arg(&input_path_owned);    // Input file

    // Smart encoding: copy if already correct codec, otherwise re-encode
    if is_h264 {
        // Video is already H.264, just copy
        cmd.arg("-c:v").arg("copy");
    } else {
        // Need to re-encode video
        #[cfg(target_os = "macos")]
        {
            cmd.arg("-c:v").arg("h264_videotoolbox")
                .arg("-q:v").arg("65")
                .arg("-profile:v").arg("main")
                .arg("-level").arg("4.0")
                .arg("-allow_sw").arg("1");
        }

        #[cfg(not(target_os = "macos"))]
        {
            cmd.arg("-c:v").arg("libx264")
                .arg("-preset").arg("fast")
                .arg("-crf").arg("23")
                .arg("-profile:v").arg("main")
                .arg("-level").arg("4.0")
                .arg("-threads").arg(&thread_count);
        }
    }

    let mut child = cmd
        .arg("-pix_fmt").arg("yuv420p")      // Pixel format for compatibility
        .arg("-movflags").arg("+faststart"); // Enable fast start for web/mobile

    // Smart audio encoding: copy if already AAC, otherwise re-encode
    if is_aac {
        child.arg("-c:a").arg("copy");
    } else {
        child.arg("-c:a").arg("aac")
            .arg("-b:a").arg("128k");
    }

    let mut child = child
        .arg("-threads").arg(&thread_count)
        .arg("-progress").arg("pipe:1")
        .arg(&output_path_for_callback)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    // Process progress output
    while let Ok(Some(line)) = reader.next_line().await {
        if line.starts_with("out_time=") {
            let time_str = line.trim_start_matches("out_time=");
            let time_seconds = parse_time_to_seconds(time_str);
            let percent = if duration > 0.0 {
                (time_seconds / duration * 100.0).min(99.0)
            } else {
                0.0
            };
            callback_clone(ConversionProgress {
                task_id: task_id_owned.clone(),
                progress: percent,
                status: "converting".to_string(),
                output_path: None,
                error: None,
            });
        }
    }

    let status = child.wait().await.map_err(|e| format!("FFmpeg process error: {}", e))?;

    if status.success() && Path::new(&output_path_str).exists() {
        callback(ConversionProgress {
            task_id: task_id.to_string(),
            progress: 100.0,
            status: "completed".to_string(),
            output_path: Some(output_path_str.clone()),
            error: None,
        });
        Ok(output_path_str)
    } else {
        let error_msg = if !status.success() {
            format!("FFmpeg exited with status: {}", status)
        } else {
            "Output file not created".to_string()
        };
        callback(ConversionProgress {
            task_id: task_id.to_string(),
            progress: 0.0,
            status: "error".to_string(),
            output_path: None,
            error: Some(error_msg.clone()),
        });
        Err(error_msg)
    }
}

pub async fn delete_file(path: &str) -> Result<(), String> {
    tokio::fs::remove_file(path)
        .await
        .map_err(|e| format!("Failed to delete file: {}", e))
}
