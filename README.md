# SoundBridg Desktop

Auto-sync FL Studio audio exports to the cloud. Export a beat, open soundbridg.com on your phone, and it's already there.

## Features

- macOS menu bar tray app — always running in the background
- Watches FL Studio export directories for new audio files
- Auto-uploads `.mp3`, `.wav`, `.flac`, `.ogg`, `.aiff`, `.m4a` files
- Configurable sync intervals (1 min to 3 hours)
- MD5 dedup — never uploads the same file twice
- Retry with exponential backoff on network errors

## Install

Download the latest DMG from [soundbridg.com](https://soundbridg.com).

## Development

```bash
npm install
npm start
```

## Build

```bash
npm run dist:universal
```

Produces a universal macOS DMG in `dist/`.
