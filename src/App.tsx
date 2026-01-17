import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./index.css";

interface VideoInfo {
  path: string;
  filename: string;
  codec: string;
  container: string;
  duration: number;
  width: number;
  height: number;
  bitrate: number;
  needs_conversion: boolean;
}

interface FileItem extends VideoInfo {
  id: string;
  selected: boolean;
  status: "pending" | "converting" | "completed" | "error";
  progress: number;
  outputPath?: string;
  error?: string;
}

interface ConversionProgress {
  task_id: string;
  progress: number;
  status: string;
  output_path?: string;
  error?: string;
}

function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [outputDir, setOutputDir] = useState<string>("");
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  // Check FFmpeg availability on mount
  useEffect(() => {
    invoke<boolean>("cmd_check_ffmpeg")
      .then(setFfmpegAvailable)
      .catch(() => setFfmpegAvailable(false));
  }, []);

  // Listen for conversion progress events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    files.forEach((file) => {
      if (file.status === "converting") {
        listen<ConversionProgress>(
          `conversion-progress-${file.id}`,
          (event) => {
            const progress = event.payload;
            setFiles((prev) =>
              prev.map((f) =>
                f.id === file.id
                  ? {
                      ...f,
                      progress: progress.progress,
                      status:
                        progress.status === "completed"
                          ? "completed"
                          : progress.status === "error"
                          ? "error"
                          : "converting",
                      outputPath: progress.output_path,
                      error: progress.error,
                    }
                  : f
              )
            );
          }
        ).then((unlisten) => unlisteners.push(unlisten));
      }
    });

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [files]);

  const handleSelectFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Video",
          extensions: [
            "mp4",
            "mov",
            "avi",
            "mkv",
            "wmv",
            "flv",
            "webm",
            "m4v",
            "mpeg",
            "mpg",
            "3gp",
          ],
        },
      ],
    });

    if (selected && Array.isArray(selected)) {
      for (const path of selected) {
        try {
          const info = await invoke<VideoInfo>("cmd_get_video_info", { path });
          const newFile: FileItem = {
            ...info,
            id: crypto.randomUUID(),
            selected: false,
            status: "pending",
            progress: 0,
          };
          setFiles((prev) => {
            // Avoid duplicates
            if (prev.some((f) => f.path === path)) return prev;
            return [...prev, newFile];
          });
        } catch (error) {
          console.error("Failed to get video info:", error);
        }
      }
    }
  };

  const handleSelectOutputDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });

    if (selected && typeof selected === "string") {
      setOutputDir(selected);
    }
  };

  const toggleFileSelection = (id: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f))
    );
  };

  const toggleSelectAll = () => {
    const allSelected = files.every((f) => f.selected);
    setFiles((prev) => prev.map((f) => ({ ...f, selected: !allSelected })));
  };

  const convertSingleFile = async (file: FileItem) => {
    if (!outputDir) {
      alert("请先选择输出目录");
      return;
    }

    setFiles((prev) =>
      prev.map((f) =>
        f.id === file.id ? { ...f, status: "converting", progress: 0 } : f
      )
    );

    try {
      const outputPath = await invoke<string>("cmd_convert_video", {
        inputPath: file.path,
        outputDir,
        taskId: file.id,
      });

      setFiles((prev) =>
        prev.map((f) =>
          f.id === file.id
            ? { ...f, status: "completed", progress: 100, outputPath }
            : f
        )
      );
    } catch (error) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === file.id
            ? { ...f, status: "error", error: String(error) }
            : f
        )
      );
    }
  };

  const convertSelectedFiles = async () => {
    const selectedFiles = files.filter(
      (f) => f.selected && f.status === "pending"
    );
    if (selectedFiles.length === 0) {
      alert("请选择要转换的文件");
      return;
    }
    if (!outputDir) {
      alert("请先选择输出目录");
      return;
    }

    setIsConverting(true);

    // Start all conversions in parallel
    await Promise.all(selectedFiles.map((file) => convertSingleFile(file)));

    setIsConverting(false);
  };

  const convertAllFiles = async () => {
    const pendingFiles = files.filter((f) => f.status === "pending");
    if (pendingFiles.length === 0) {
      alert("没有可转换的文件");
      return;
    }
    if (!outputDir) {
      alert("请先选择输出目录");
      return;
    }

    setIsConverting(true);

    await Promise.all(pendingFiles.map((file) => convertSingleFile(file)));

    setIsConverting(false);
  };

  const deleteFile = useCallback(async (file: FileItem) => {
    // If completed, also delete the output file
    if (file.status === "completed" && file.outputPath) {
      try {
        await invoke("cmd_delete_file", { path: file.outputPath });
      } catch (error) {
        console.error("Failed to delete output file:", error);
      }
    }
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
  }, []);

  const deleteSelectedFiles = async () => {
    const selectedFiles = files.filter((f) => f.selected);
    for (const file of selectedFiles) {
      await deleteFile(file);
    }
  };

  const removeFromList = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const selectedCount = files.filter((f) => f.selected).length;
  const pendingCount = files.filter((f) => f.status === "pending").length;

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatResolution = (width: number, height: number) => {
    return `${width}x${height}`;
  };

  return (
    <div className="app">
      <header className="header">
        <h1>MP4 转换器</h1>
        <div className="ffmpeg-status">
          <span
            className={`status-dot ${ffmpegAvailable ? "ok" : "error"}`}
          ></span>
          <span>
            FFmpeg {ffmpegAvailable ? "就绪" : "未找到"}
          </span>
        </div>
      </header>

      <div className="toolbar">
        <button
          className="btn btn-primary"
          onClick={handleSelectFiles}
          disabled={!ffmpegAvailable}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          添加文件
        </button>
        <button
          className="btn btn-success"
          onClick={convertSelectedFiles}
          disabled={!ffmpegAvailable || selectedCount === 0 || isConverting || !outputDir}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 12l5 5L20 7" />
          </svg>
          转换选中 ({selectedCount})
        </button>
        <button
          className="btn btn-success"
          onClick={convertAllFiles}
          disabled={!ffmpegAvailable || pendingCount === 0 || isConverting || !outputDir}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 12l5 5L20 7" />
          </svg>
          转换全部 ({pendingCount})
        </button>
        <button
          className="btn btn-danger"
          onClick={deleteSelectedFiles}
          disabled={selectedCount === 0 || isConverting}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          删除选中
        </button>
      </div>

      <div className="output-selector">
        <label>输出目录：</label>
        <span className="output-path">
          {outputDir || "请选择输出目录"}
        </span>
        <button className="btn btn-secondary" onClick={handleSelectOutputDir}>
          浏览
        </button>
      </div>

      <div className="file-list-container">
        <div className="file-list-header">
          <div className="select-all-checkbox">
            <input
              type="checkbox"
              checked={files.length > 0 && files.every((f) => f.selected)}
              onChange={toggleSelectAll}
              disabled={files.length === 0}
            />
            <span>全选 ({files.length} 个文件)</span>
          </div>
        </div>

        <div className="file-list">
          {files.length === 0 ? (
            <div className="file-list-empty">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <p>点击"添加文件"选择视频文件</p>
            </div>
          ) : (
            files.map((file) => (
              <div
                key={file.id}
                className={`file-item ${file.selected ? "selected" : ""}`}
              >
                <div className="file-item-checkbox">
                  <input
                    type="checkbox"
                    checked={file.selected}
                    onChange={() => toggleFileSelection(file.id)}
                  />
                </div>

                <div className="file-item-info">
                  <div className="file-item-name" title={file.path}>
                    {file.filename}
                  </div>
                  <div className="file-item-meta">
                    <span>{file.codec.toUpperCase()}</span>
                    <span>{file.container}</span>
                    <span>{formatResolution(file.width, file.height)}</span>
                    <span>{formatDuration(file.duration)}</span>
                    {file.needs_conversion ? (
                      <span className="badge badge-warning">需要转换</span>
                    ) : (
                      <span className="badge badge-success">已兼容</span>
                    )}
                  </div>
                </div>

                {file.status !== "pending" && (
                  <div className="file-item-progress">
                    <div className="progress-bar">
                      <div
                        className={`progress-bar-fill ${
                          file.status === "completed"
                            ? "completed"
                            : file.status === "error"
                            ? "error"
                            : ""
                        }`}
                        style={{ width: `${file.progress}%` }}
                      />
                    </div>
                    <div className="progress-text">
                      {file.status === "converting"
                        ? `${Math.round(file.progress)}%`
                        : file.status === "completed"
                        ? "完成"
                        : file.status === "error"
                        ? "错误"
                        : ""}
                    </div>
                  </div>
                )}

                <div className="file-item-actions">
                  {file.status === "pending" && (
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() => convertSingleFile(file)}
                      disabled={isConverting || !outputDir}
                    >
                      转换
                    </button>
                  )}
                  <button
                    className="icon-btn danger"
                    onClick={() =>
                      file.status === "completed"
                        ? deleteFile(file)
                        : removeFromList(file.id)
                    }
                    title={
                      file.status === "completed"
                        ? "删除输出文件"
                        : "从列表移除"
                    }
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
