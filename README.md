# Video Subtitle Generator

Add subtitles to videos using FFCreator and FFmpeg.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Make sure FFmpeg is installed on your system:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get install ffmpeg
```

3. Start the server:
```bash
npm start
```

4. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. Upload a video file (MP4, AVI, MOV, or MKV)
2. Add subtitle entries with text and timing (start/end in seconds)
3. Click "Generate Video" to process
4. Download the output video with embedded subtitles

## API Endpoint

**POST** `/api/add-subtitles`

- **video**: Video file (multipart/form-data)
- **subtitles**: JSON array of subtitle objects
  ```json
  [
    {
      "text": "Hello World",
      "startTime": 0,
      "endTime": 2.5
    }
  ]
  ```

## Development

```bash
npm run dev
```
