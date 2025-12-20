const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/outputs', express.static('outputs'));

// Create directories
['uploads', 'outputs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|avi|mov|mkv|quicktime|x-msvideo|x-matroska/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname || mimetype) return cb(null, true);
    cb(null, false);
  }
});

app.post('/api/add-subtitles', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }
    
    const { subtitles, style, font } = req.body;
    if (!subtitles) {
      return res.status(400).json({ success: false, error: 'No subtitles provided' });
    }

    const videoPath = req.file.path;
    const outputPath = path.join('outputs', `output-${Date.now()}.mp4`);
    
    let subtitleData;
    try {
      subtitleData = JSON.parse(subtitles);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid subtitle format' });
    }

    // Generate SRT subtitle file
    const srtPath = path.join('uploads', `subtitles-${Date.now()}.srt`);
    let srtContent = '';
    subtitleData.forEach((sub, index) => {
      const startTime = formatSRTTime(sub.startTime);
      const endTime = formatSRTTime(sub.endTime);
      srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${sub.text}\n\n`;
    });
    fs.writeFileSync(srtPath, srtContent);

    // Get selected font or default to Arial
    const selectedFont = font || 'Arial';

    // Define subtitle styles with dynamic font
    const styles = {
      classic: `FontName=${selectedFont},FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=20`,
      modern: `FontName=${selectedFont},FontSize=28,Bold=1,PrimaryColour=&H00D7FF&,OutlineColour=&H000000&,BorderStyle=3,Outline=3,Shadow=0,MarginV=20`,
      minimal: `FontName=${selectedFont},FontSize=22,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=1,Shadow=2,MarginV=20`,
      bold: `FontName=${selectedFont},FontSize=32,Bold=1,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=4,Shadow=0,MarginV=20`,
      neon: `FontName=${selectedFont},FontSize=26,Bold=1,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=3,MarginV=20`,
      boxed: `FontName=${selectedFont},FontSize=24,PrimaryColour=&HFFFFFF&,BackColour=&H80000000&,BorderStyle=4,Outline=0,Shadow=0,MarginV=20,MarginL=10,MarginR=10`
    };

    const selectedStyle = styles[style] || styles.classic;

    // Use FFmpeg to burn subtitles into video
    ffmpeg(videoPath)
      .videoFilters(`subtitles=${srtPath}:force_style='${selectedStyle}'`)
      .output(outputPath)
      .on('end', () => {
        // Clean up
        fs.unlinkSync(videoPath);
        fs.unlinkSync(srtPath);
        res.json({ 
          success: true, 
          outputUrl: `/outputs/${path.basename(outputPath)}` 
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
        res.status(500).json({ success: false, error: 'Video processing failed', details: err.message });
      })
      .run();

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: 'Server error', details: error.message });
  }
});

// Helper function to format time for SRT
function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
