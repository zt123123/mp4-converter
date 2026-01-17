#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

// Detect platform and architecture
function getTarget() {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const platform = process.platform;

    if (platform === 'darwin') {
        return `${arch}-apple-darwin`;
    } else if (platform === 'win32') {
        return `${arch}-pc-windows-msvc`;
    } else {
        return `${arch}-unknown-linux-gnu`;
    }
}

async function main() {
    const target = getTarget();
    console.log(`Target: ${target}`);

    // Create binaries directory
    if (!fs.existsSync(BINARIES_DIR)) {
        fs.mkdirSync(BINARIES_DIR, { recursive: true });
    }

    const ffmpegDest = path.join(BINARIES_DIR, `ffmpeg-${target}`);
    const ffprobeDest = path.join(BINARIES_DIR, `ffprobe-${target}`);

    // Check if binaries already exist
    if (fs.existsSync(ffmpegDest) && fs.existsSync(ffprobeDest)) {
        console.log('FFmpeg binaries already exist, skipping download.');
        return;
    }

    if (process.platform === 'darwin') {
        // Use Homebrew to get ffmpeg
        console.log('Checking for ffmpeg...');

        // First check if ffmpeg is already installed
        const ffmpegWhich = spawnSync('which', ['ffmpeg']);
        let ffmpegSrc, ffprobeSrc;

        if (ffmpegWhich.status === 0) {
            ffmpegSrc = ffmpegWhich.stdout.toString().trim();
            ffprobeSrc = ffmpegSrc.replace('/ffmpeg', '/ffprobe');
            console.log(`Found existing ffmpeg at: ${ffmpegSrc}`);
        } else {
            // Check if brew is available
            const brewCheck = spawnSync('which', ['brew']);
            if (brewCheck.status !== 0) {
                console.error('Neither ffmpeg nor Homebrew is installed.');
                console.error('Please install ffmpeg: brew install ffmpeg');
                process.exit(1);
            }

            // Check if ffmpeg is installed via brew
            const ffmpegCheck = spawnSync('brew', ['--prefix', 'ffmpeg']);
            if (ffmpegCheck.status !== 0) {
                console.log('Installing ffmpeg via Homebrew...');
                execSync('brew install ffmpeg', { stdio: 'inherit' });
            }

            // Get the ffmpeg path from brew
            const brewPrefix = execSync('brew --prefix ffmpeg').toString().trim();
            ffmpegSrc = path.join(brewPrefix, 'bin', 'ffmpeg');
            ffprobeSrc = path.join(brewPrefix, 'bin', 'ffprobe');
        }

        if (!fs.existsSync(ffmpegSrc)) {
            console.error('ffmpeg binary not found at:', ffmpegSrc);
            process.exit(1);
        }

        if (!fs.existsSync(ffprobeSrc)) {
            console.error('ffprobe binary not found at:', ffprobeSrc);
            process.exit(1);
        }

        // Copy binaries
        console.log(`Copying ffmpeg from ${ffmpegSrc} to ${ffmpegDest}`);
        fs.copyFileSync(ffmpegSrc, ffmpegDest);
        fs.chmodSync(ffmpegDest, 0o755);

        console.log(`Copying ffprobe from ${ffprobeSrc} to ${ffprobeDest}`);
        fs.copyFileSync(ffprobeSrc, ffprobeDest);
        fs.chmodSync(ffprobeDest, 0o755);

        console.log('FFmpeg binaries copied successfully!');

    } else {
        console.error('Please download FFmpeg binaries manually for your platform');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
