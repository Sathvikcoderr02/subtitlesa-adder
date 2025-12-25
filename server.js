require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const app = express();
const PORT = 3001;

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

// Helper function to escape path for FFmpeg subtitles filter
function escapeFFmpegPath(filePath) {
  // FFmpeg subtitles filter requires escaping: \ : ' [ ]
  return filePath
    .replace(/\\/g, '\\\\\\\\')  // Escape backslashes (need 4 for FFmpeg)
    .replace(/:/g, '\\:')         // Escape colons
    .replace(/'/g, "\\'")         // Escape single quotes
    .replace(/\[/g, '\\[')        // Escape brackets
    .replace(/\]/g, '\\]');
}

// Helper function to get word timings - uses actual timings from STT if available
function calculateWordTimings(subtitle) {
  const { text, startTime, endTime, wordTimings } = subtitle;
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  // If we have actual word timings from STT, use them (much better sync!)
  if (wordTimings && wordTimings.length > 0) {
    console.log('Using actual word timings from STT for better sync');
    return wordTimings.map(wt => ({
      word: wt.word,
      start: wt.start,
      end: wt.end
    }));
  }

  // Fallback: calculate evenly distributed timings
  console.log('Fallback: calculating estimated word timings');
  const duration = endTime - startTime;
  const buffer = duration * 0.05; // 5% buffer at start/end
  const effectiveStart = startTime + buffer;
  const wordDuration = (duration - buffer * 2) / words.length;

  return words.map((word, i) => ({
    word,
    start: effectiveStart + (i * wordDuration),
    end: effectiveStart + ((i + 1) * wordDuration)
  }));
}

// Helper function to calculate word X positions for natural text flow
function calculateWordPositions(words, fontSize) {
  const charWidth = fontSize * 0.52;  // Character width estimation (average)
  const spaceWidth = fontSize * 0.5;  // Space between words
  let x = 0;
  const positions = words.map(word => {
    const pos = { word, xOffset: Math.round(x) };
    x += (word.length * charWidth) + spaceWidth;
    return pos;
  });
  return { positions, totalWidth: Math.max(1, Math.round(x - spaceWidth)) };
}

// Helper function to convert BGR color to FFmpeg hex format
function convertBGRtoHex(bgrColor) {
  const colorHex = bgrColor.replace('&H', '').replace('&', '');
  const b = parseInt(colorHex.substr(0, 2), 16);
  const g = parseInt(colorHex.substr(2, 2), 16);
  const r = parseInt(colorHex.substr(4, 2), 16);
  return `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Helper function to split text into lines by words per line
// Split text by words per line - for ASS format (uses \N for line break)
function splitTextByWordsPerLineASS(text, wordsPerLine) {
  if (!wordsPerLine || wordsPerLine <= 0) return text;

  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= wordsPerLine) return text;

  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(' '));
  }
  return lines.join('\\N'); // \N is ASS line break
}

// Split text by words per line - for drawtext (uses actual newline)
function splitTextByWordsPerLine(text, wordsPerLine) {
  if (!wordsPerLine || wordsPerLine <= 0) return text;

  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= wordsPerLine) return text;

  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(' '));
  }
  return lines.join('\n'); // actual newline for drawtext
}

// Create word-by-word highlight filter (karaoke style with background box)
function createWordHighlightFilter(subtitle, font, baseColor, highlightColor, position, bgColor, fontSize, wordsPerLine = 0) {
  const timings = calculateWordTimings(subtitle);
  if (timings.length === 0) return null;

  // Use words from timings for accurate sync
  const words = timings.map(t => t.word);
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);

  const filters = [];
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split words into lines if wordsPerLine is set
  const effectiveWPL = wordsPerLine > 0 ? wordsPerLine : words.length;
  const lines = [];
  const lineTimings = [];
  for (let i = 0; i < words.length; i += effectiveWPL) {
    lines.push(words.slice(i, Math.min(i + effectiveWPL, words.length)));
    lineTimings.push(timings.slice(i, Math.min(i + effectiveWPL, timings.length)));
  }

  const totalLines = lines.length;
  const totalBlockHeight = totalLines * lineHeight;

  // Calculate base Y position based on alignment
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalBlockHeight})/2`;
  } else {
    baseY = `h-${totalBlockHeight}-50`;
  }

  lines.forEach((lineWords, lineIndex) => {
    const { positions: linePositions, totalWidth } = calculateWordPositions(lineWords, fontSizeNum);
    const currentLineTimings = lineTimings[lineIndex];

    const yOffset = lineIndex * lineHeight;
    const yExpr = typeof baseY === 'string' ? `${baseY}+${yOffset}` : `${baseY + yOffset}`;

    // Draw all words in base color
    lineWords.forEach((word, i) => {
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${subtitle.startTime},${subtitle.endTime})'`
      );
    });

    // Add highlight with ACTUAL word timing from STT
    lineWords.forEach((word, i) => {
      const timing = currentLineTimings[i];
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}:x=${xExpr}:y=${yExpr}:box=1:boxcolor=${highlightColor}@0.7:boxborderw=6:borderw=2:bordercolor=black:enable='between(t,${timing.start},${timing.end})'`
      );
    });
  });

  return filters.join(',');
}

// Create word-by-word fill filter (progressive color change that stays)
function createWordFillFilter(subtitle, font, baseColor, fillColor, position, bgColor, fontSize, wordsPerLine = 0) {
  const timings = calculateWordTimings(subtitle);
  if (timings.length === 0) return null;

  // Use words from timings for accurate sync
  const words = timings.map(t => t.word);
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.2);

  const filters = [];
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split words into lines if wordsPerLine is set
  const effectiveWPL = wordsPerLine > 0 ? wordsPerLine : words.length;
  const lines = [];
  const lineTimings = [];
  for (let i = 0; i < words.length; i += effectiveWPL) {
    lines.push(words.slice(i, Math.min(i + effectiveWPL, words.length)));
    lineTimings.push(timings.slice(i, Math.min(i + effectiveWPL, timings.length)));
  }

  const totalLines = lines.length;
  const totalBlockHeight = totalLines * lineHeight;

  // Calculate base Y position based on alignment
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalBlockHeight})/2`;
  } else {
    baseY = `h-${totalBlockHeight}-50`;
  }

  lines.forEach((lineWords, lineIndex) => {
    const { positions: linePositions, totalWidth } = calculateWordPositions(lineWords, fontSizeNum);
    const currentLineTimings = lineTimings[lineIndex];

    const yOffset = lineIndex * lineHeight;
    const yExpr = typeof baseY === 'string' ? `${baseY}+${yOffset}` : `${baseY + yOffset}`;

    // Add fill transitions with ACTUAL word timing from STT
    lineWords.forEach((word, i) => {
      const timing = currentLineTimings[i];
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");

      // Base color: visible from subtitle start until word's turn
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${subtitle.startTime},${timing.start})'`
      );

      // Fill color: visible from word's turn until subtitle ends (stays filled)
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${fillColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${timing.start},${subtitle.endTime})'`
      );
    });
  });

  return filters.join(',');
}

// Create word-by-word color change filter (current word changes color, synced with speech)
function createWordColorFilter(subtitle, font, baseColor, highlightColor, position, bgColor, fontSize, wordsPerLine = 0) {
  const timings = calculateWordTimings(subtitle);
  if (timings.length === 0) return null;

  // Use words from timings for accurate sync
  const words = timings.map(t => t.word);
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);

  const filters = [];
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split words into lines if wordsPerLine is set
  const effectiveWPL = wordsPerLine > 0 ? wordsPerLine : words.length;
  const lines = [];
  const lineTimings = [];
  for (let i = 0; i < words.length; i += effectiveWPL) {
    lines.push(words.slice(i, Math.min(i + effectiveWPL, words.length)));
    lineTimings.push(timings.slice(i, Math.min(i + effectiveWPL, timings.length)));
  }

  const totalLines = lines.length;
  const totalBlockHeight = totalLines * lineHeight;

  // Calculate base Y position based on alignment
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalBlockHeight})/2`;
  } else {
    baseY = `h-${totalBlockHeight}-50`;
  }

  lines.forEach((lineWords, lineIndex) => {
    const { positions: linePositions, totalWidth } = calculateWordPositions(lineWords, fontSizeNum);
    const currentLineTimings = lineTimings[lineIndex];

    const yOffset = lineIndex * lineHeight;
    const yExpr = typeof baseY === 'string' ? `${baseY}+${yOffset}` : `${baseY + yOffset}`;

    // For each word: show in base color when NOT being spoken, highlight color when spoken
    lineWords.forEach((word, i) => {
      const timing = currentLineTimings[i];
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");

      // Base color: show before and after this word's timing
      // Before: from subtitle start to word start
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${subtitle.startTime},${timing.start})'`
      );
      // After: from word end to subtitle end
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${timing.end},${subtitle.endTime})'`
      );

      // Highlight color: during this word's timing (current spoken word)
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${highlightColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${timing.start},${timing.end})'`
      );
    });
  });

  return filters.join(',');
}

// Create word-by-word reveal filter (words appear one by one as spoken)
function createWordRevealFilter(subtitle, font, textColor, position, bgColor, fontSize, wordsPerLine = 0) {
  const timings = calculateWordTimings(subtitle);
  if (timings.length === 0) return null;

  // Use words from timings for accurate sync
  const words = timings.map(t => t.word);
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);

  const filters = [];
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split words into lines if wordsPerLine is set
  const effectiveWPL = wordsPerLine > 0 ? wordsPerLine : words.length;
  const lines = [];
  const lineTimings = [];
  for (let i = 0; i < words.length; i += effectiveWPL) {
    lines.push(words.slice(i, Math.min(i + effectiveWPL, words.length)));
    lineTimings.push(timings.slice(i, Math.min(i + effectiveWPL, timings.length)));
  }

  const totalLines = lines.length;
  const totalBlockHeight = totalLines * lineHeight;

  // Calculate base Y position based on alignment
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalBlockHeight})/2`;
  } else {
    baseY = `h-${totalBlockHeight}-50`;
  }

  lines.forEach((lineWords, lineIndex) => {
    const { positions: linePositions, totalWidth } = calculateWordPositions(lineWords, fontSizeNum);
    const currentLineTimings = lineTimings[lineIndex];

    const yOffset = lineIndex * lineHeight;
    const yExpr = typeof baseY === 'string' ? `${baseY}+${yOffset}` : `${baseY + yOffset}`;

    // Each word appears when spoken and stays until subtitle ends
    lineWords.forEach((word, i) => {
      const timing = currentLineTimings[i];
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");

      // Word appears from its start time and stays until subtitle ends
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${textColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${timing.start},${subtitle.endTime})'`
      );
    });
  });

  return filters.join(',');
}

// Create stroke animation (outline first, then fills with color when spoken)
function createStrokeFilter(subtitle, font, baseColor, fillColor, position, bgColor, fontSize, wordsPerLine = 0) {
  const timings = calculateWordTimings(subtitle);
  if (timings.length === 0) return null;

  // Use words from timings for accurate sync
  const words = timings.map(t => t.word);
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);

  const filters = [];
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split words into lines if wordsPerLine is set
  const effectiveWPL = wordsPerLine > 0 ? wordsPerLine : words.length;
  const lines = [];
  const lineTimings = [];
  for (let i = 0; i < words.length; i += effectiveWPL) {
    lines.push(words.slice(i, Math.min(i + effectiveWPL, words.length)));
    lineTimings.push(timings.slice(i, Math.min(i + effectiveWPL, timings.length)));
  }

  const totalLines = lines.length;
  const totalBlockHeight = totalLines * lineHeight;

  // Calculate base Y position based on alignment
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalBlockHeight})/2`;
  } else {
    baseY = `h-${totalBlockHeight}-50`;
  }

  lines.forEach((lineWords, lineIndex) => {
    const { positions: linePositions, totalWidth } = calculateWordPositions(lineWords, fontSizeNum);
    const currentLineTimings = lineTimings[lineIndex];

    const yOffset = lineIndex * lineHeight;
    const yExpr = typeof baseY === 'string' ? `${baseY}+${yOffset}` : `${baseY + yOffset}`;

    lineWords.forEach((word, i) => {
      const timing = currentLineTimings[i];
      const xExpr = `(w-${totalWidth})/2+${linePositions[i].xOffset}`;
      const escaped = word.replace(/'/g, "\\'").replace(/:/g, "\\:");

      // Outline only (before word is spoken): thick border, transparent-ish text
      // Use base color for outline with low alpha for text
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${baseColor}@0.3:x=${xExpr}:y=${yExpr}:borderw=3:bordercolor=${baseColor}:enable='between(t,${subtitle.startTime},${timing.start})'`
      );

      // Filled (when word is spoken): full color text with border
      filters.push(
        `drawtext=text='${escaped}':font='${escapedFont}':fontsize=${fontSizeNum}:fontcolor=${fillColor}:x=${xExpr}:y=${yExpr}:borderw=2:bordercolor=black:enable='between(t,${timing.start},${subtitle.endTime})'`
      );
    });
  });

  return filters.join(',');
}

// Create fire text effect (flickering orange/red/yellow colors)
function createFireTextFilter(subtitle, font, position, fontSize, wordsPerLine = 0) {
  const { text, startTime, endTime } = subtitle;
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split text into lines if wordsPerLine is set
  let lines = [text];
  if (wordsPerLine > 0) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    lines = [];
    for (let i = 0; i < words.length; i += wordsPerLine) {
      lines.push(words.slice(i, Math.min(i + wordsPerLine, words.length)).join(' '));
    }
  }

  const totalLines = lines.length;
  const totalHeight = totalLines * lineHeight;

  // Calculate base Y position
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalHeight})/2`;
  } else {
    baseY = `h-${totalHeight}-50`;
  }

  // Fire colors - cycle through red, orange, yellow
  const fireColors = ['0xff4500', '0xff6600', '0xffcc00', '0xff8c00', '0xff0000'];
  const filters = [];

  lines.forEach((line, lineIndex) => {
    const escapedText = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const yOffset = lineIndex * lineHeight;
    const lineY = typeof baseY === 'string' ? `${baseY}+${yOffset}` : baseY + yOffset;

    // Create flickering effect by rapidly alternating colors based on time
    // Use multiple overlapping drawtext with different enables for flicker effect
    fireColors.forEach((color, colorIndex) => {
      const flickerSpeed = 0.15; // How fast to flicker
      const offset = colorIndex * flickerSpeed;
      const cycleDuration = fireColors.length * flickerSpeed;

      // Create a time-based color cycling effect
      // Each color shows for flickerSpeed seconds, then cycles
      filters.push(
        `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${color}:x=(w-text_w)/2:y=${lineY}:borderw=3:bordercolor=0x8b0000:shadowy=2:shadowx=2:shadowcolor=0x330000:alpha='if(lt(mod(t-${startTime}+${offset}\\,${cycleDuration})\\,${flickerSpeed})\\,1\\,0)':enable='between(t,${startTime},${endTime})'`
      );
    });

    // Add a constant glow/base layer
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0xff6600:x=(w-text_w)/2:y=${lineY}:borderw=4:bordercolor=0x8b0000:alpha=0.3:enable='between(t,${startTime},${endTime})'`
    );
  });

  return filters.join(',');
}

// Create ice text effect (shimmering blue/cyan/white colors)
function createIceTextFilter(subtitle, font, position, fontSize, wordsPerLine = 0) {
  const { text, startTime, endTime } = subtitle;
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split text into lines if wordsPerLine is set
  let lines = [text];
  if (wordsPerLine > 0) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    lines = [];
    for (let i = 0; i < words.length; i += wordsPerLine) {
      lines.push(words.slice(i, Math.min(i + wordsPerLine, words.length)).join(' '));
    }
  }

  const totalLines = lines.length;
  const totalHeight = totalLines * lineHeight;

  // Calculate base Y position
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalHeight})/2`;
  } else {
    baseY = `h-${totalHeight}-50`;
  }

  // Ice colors - cycle through white, light blue, cyan, deep blue
  const iceColors = ['0xffffff', '0x87ceeb', '0x00bfff', '0xb0e0e6', '0x00ffff'];
  const filters = [];

  lines.forEach((line, lineIndex) => {
    const escapedText = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const yOffset = lineIndex * lineHeight;
    const lineY = typeof baseY === 'string' ? `${baseY}+${yOffset}` : baseY + yOffset;

    // Create shimmering effect by cycling through ice colors
    iceColors.forEach((color, colorIndex) => {
      const shimmerSpeed = 0.12; // Slightly faster shimmer for ice
      const offset = colorIndex * shimmerSpeed;
      const cycleDuration = iceColors.length * shimmerSpeed;

      filters.push(
        `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${color}:x=(w-text_w)/2:y=${lineY}:borderw=3:bordercolor=0x4169e1:shadowy=1:shadowx=1:shadowcolor=0x000080:alpha='if(lt(mod(t-${startTime}+${offset}\\,${cycleDuration})\\,${shimmerSpeed})\\,1\\,0)':enable='between(t,${startTime},${endTime})'`
      );
    });

    // Add a constant frost/glow base layer
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0x87ceeb:x=(w-text_w)/2:y=${lineY}:borderw=4:bordercolor=0x4682b4:alpha=0.3:enable='between(t,${startTime},${endTime})'`
    );
  });

  return filters.join(',');
}

// Create glitch effect (RGB splitting and jitter)
function createGlitchFilter(subtitle, font, position, fontSize, wordsPerLine = 0) {
  const { text, startTime, endTime } = subtitle;
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Split text into lines if wordsPerLine is set
  let lines = [text];
  if (wordsPerLine > 0) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    lines = [];
    for (let i = 0; i < words.length; i += wordsPerLine) {
      lines.push(words.slice(i, Math.min(i + wordsPerLine, words.length)).join(' '));
    }
  }

  const totalLines = lines.length;
  const totalHeight = totalLines * lineHeight;

  // Calculate base Y position
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalHeight})/2`;
  } else {
    baseY = `h-${totalHeight}-50`;
  }

  const filters = [];

  lines.forEach((line, lineIndex) => {
    const escapedText = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const yOffset = lineIndex * lineHeight;
    const lineY = typeof baseY === 'string' ? `${baseY}+${yOffset}` : baseY + yOffset;

    // Red channel - offset left with random jitter
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0xff0000@0.7:x=(w-text_w)/2-4+2*sin(t*30):y=${lineY}+2*cos(t*25):enable='between(t,${startTime},${endTime})'`
    );

    // Green channel - offset right with different jitter
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0x00ff00@0.7:x=(w-text_w)/2+4+2*cos(t*35):y=${lineY}+2*sin(t*20):enable='between(t,${startTime},${endTime})'`
    );

    // Blue channel - slight offset with jitter
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0x0000ff@0.7:x=(w-text_w)/2+2*sin(t*40):y=${lineY}-2+2*cos(t*30):enable='between(t,${startTime},${endTime})'`
    );

    // Main white text on top
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0xffffff:x=(w-text_w)/2:y=${lineY}:borderw=1:bordercolor=black:enable='between(t,${startTime},${endTime})'`
    );

    // Random glitch flashes (appears/disappears rapidly)
    filters.push(
      `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=0x00ffff:x=(w-text_w)/2+8*sin(t*50):y=${lineY}:alpha='if(lt(mod(t*10\\,1)\\,0.1)\\,0.8\\,0)':enable='between(t,${startTime},${endTime})'`
    );
  });

  return filters.join(',');
}

// Helper function to create animation filters with multi-line support
function createAnimationFilter(subtitle, font, color, position, bgColor, animation, fontSize, index, wordsPerLine = 0) {
  const { text, startTime, endTime } = subtitle;
  const duration = endTime - startTime;
  const fontSizeNum = parseInt(fontSize);
  const lineHeight = Math.round(fontSizeNum * 1.3);

  // Convert color from &HBBGGRR& format to RGB hex
  const colorHex = color.replace('&H', '').replace('&', '');
  const b = parseInt(colorHex.substr(0, 2), 16);
  const g = parseInt(colorHex.substr(2, 2), 16);
  const r = parseInt(colorHex.substr(4, 2), 16);
  const textColor = `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

  // Split text into lines if wordsPerLine is set
  let lines = [text];
  if (wordsPerLine > 0) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    lines = [];
    for (let i = 0; i < words.length; i += wordsPerLine) {
      lines.push(words.slice(i, Math.min(i + wordsPerLine, words.length)).join(' '));
    }
  }

  const totalLines = lines.length;
  const totalHeight = totalLines * lineHeight;

  // Background color mapping for drawtext box
  const bgColorMap = {
    'none': '',
    'black': ':box=1:boxcolor=black@0.5:boxborderw=8',
    'solid-black': ':box=1:boxcolor=black@1:boxborderw=8',
    'white': ':box=1:boxcolor=white@0.5:boxborderw=8',
    'solid-white': ':box=1:boxcolor=white@1:boxborderw=8',
    'gray': ':box=1:boxcolor=gray@0.5:boxborderw=8',
    'dark-gray': ':box=1:boxcolor=0x404040@0.5:boxborderw=8',
    'blue': ':box=1:boxcolor=blue@0.5:boxborderw=8',
    'red': ':box=1:boxcolor=red@0.5:boxborderw=8',
    'green': ':box=1:boxcolor=green@0.5:boxborderw=8',
    'yellow': ':box=1:boxcolor=yellow@0.5:boxborderw=8',
    'purple': ':box=1:boxcolor=purple@0.5:boxborderw=8'
  };
  const boxStyle = bgColorMap[bgColor] || '';
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Calculate base Y position
  let baseY;
  if (position.includes('top')) {
    baseY = 50;
  } else if (position.includes('middle')) {
    baseY = `(h-${totalHeight})/2`;
  } else {
    baseY = `h-${totalHeight}-50`;
  }

  // Create filter for each line
  const filters = [];
  lines.forEach((line, lineIndex) => {
    const escapedText = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const yOffset = lineIndex * lineHeight;
    const lineY = typeof baseY === 'string' ? `${baseY}+${yOffset}` : baseY + yOffset;

    switch (animation) {
      case 'fade-in':
        filters.push(`drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y=${lineY}:alpha='if(lt(t-${startTime},0.5),(t-${startTime})/0.5,1)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`);
        break;

      case 'slide-up':
        filters.push(`drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y='(h-50)+((${lineY})-(h-50))*min(1\\,(t-${startTime})/0.8)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`);
        break;

      case 'slide-left':
        filters.push(`drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x='(w)+((w-text_w)/2-(w))*min(1\\,(t-${startTime})/0.8)':y=${lineY}:borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`);
        break;

      case 'bounce':
        filters.push(`drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y='(${lineY})-if(lt(t-${startTime}\\,0.5)\\,30*sin(6*(t-${startTime}))\\,0)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`);
        break;

      case 'typewriter':
        const typeDuration = Math.min(duration * 0.8, Math.max(0.5, line.length * 0.08));
        filters.push(`drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y=${lineY}:alpha='min(1\\,(t-${startTime})/${typeDuration})':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`);
        break;
    }
  });

  return filters.length > 0 ? filters.join(',') : null;
}

app.post('/api/add-subtitles', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }
    
    const { subtitles, style, font, fontSize, color, position, bgColor, animation, effectColor, wordsPerLine, outlineColor, outlineThickness, shadowColor, shadowDepth } = req.body;
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

    // Generate subtitle file path (use absolute path for FFmpeg compatibility)
    const subtitlePath = path.resolve('uploads', `subtitles-${Date.now()}.ass`);

    // Get selected options or defaults
    const selectedFont = font || 'Arial';
    const selectedFontSize = parseInt(fontSize) || 24;
    const selectedColor = color || 'white';
    const selectedPosition = position || 'bottom-center';
    const selectedBgColor = bgColor || 'none';
    const selectedAnimation = animation || 'none';
    const selectedWordsPerLine = parseInt(wordsPerLine) || 0;
    const selectedOutlineColor = outlineColor || 'black';
    const selectedOutlineThickness = parseInt(outlineThickness) || 2;
    const selectedShadowColor = shadowColor || 'black';
    const selectedShadowDepth = parseInt(shadowDepth) || 1;

    // Apply words per line splitting to subtitle text (ONLY for ASS subtitles - animation 'none')
    // Drawtext animations don't support multi-line text properly
    if (selectedWordsPerLine > 0 && selectedAnimation === 'none') {
      subtitleData = subtitleData.map(sub => ({
        ...sub,
        text: splitTextByWordsPerLineASS(sub.text, selectedWordsPerLine)
      }));
    }

    console.log('Processing video with:', { style, font: selectedFont, fontSize: selectedFontSize, color: selectedColor, position: selectedPosition, bgColor: selectedBgColor, animation: selectedAnimation, wordsPerLine: selectedWordsPerLine });

    // Define color mappings (FFmpeg uses BGR format: &HBBGGRR&)
    const colors = {
      white: '&HFFFFFF&',
      yellow: '&H00FFFF&',  // Fixed: Yellow in BGR
      cyan: '&HFFFF00&',    // Fixed: Cyan in BGR  
      red: '&H0000FF&',     // Red in BGR
      green: '&H00FF00&',   // Green in BGR
      blue: '&HFF0000&',    // Blue in BGR
      purple: '&HFF00FF&',  // Fixed: Purple in BGR
      orange: '&H0080FF&',  // Fixed: Orange in BGR
      pink: '&HFF80FF&',    // Fixed: Pink in BGR
      gold: '&H00D7FF&',    // Gold in BGR
      silver: '&HC0C0C0&',  // Silver in BGR
      rainbow: '&HFF00FF&'  // Use magenta for rainbow (closest single color)
    };

    const textColor = colors[selectedColor] || colors.white;

    // Define position mappings (FFmpeg ASS Alignment system - FIXED)
    // ASS alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right
    //                4=middle-left, 5=middle-center, 6=middle-right
    //                7=top-left, 8=top-center, 9=top-right
    const positions = {
      'bottom-left': { Alignment: 1, MarginV: 30, MarginL: 30, MarginR: 0 },
      'bottom-center': { Alignment: 2, MarginV: 30, MarginL: 0, MarginR: 0 },
      'bottom-right': { Alignment: 3, MarginV: 30, MarginL: 0, MarginR: 30 },
      'middle-left': { Alignment: 4, MarginV: 0, MarginL: 30, MarginR: 0 },
      'middle-center': { Alignment: 5, MarginV: 0, MarginL: 0, MarginR: 0 },
      'middle-right': { Alignment: 6, MarginV: 0, MarginL: 0, MarginR: 30 },
      'top-left': { Alignment: 7, MarginV: 30, MarginL: 30, MarginR: 0 },
      'top-center': { Alignment: 8, MarginV: 30, MarginL: 0, MarginR: 0 },
      'top-right': { Alignment: 9, MarginV: 30, MarginL: 0, MarginR: 30 }
    };

    const positionSettings = positions[selectedPosition] || positions['bottom-center'];

    // Define background color mappings (FFmpeg uses BGR format with alpha for BackColour)
    const bgColors = {
      none: '',
      black: ',BackColour=&H80000000&',        // Semi-transparent black (default-like)
      'solid-black': ',BackColour=&H000000&',  // Solid black
      white: ',BackColour=&H80FFFFFF&',        // Semi-transparent white
      'solid-white': ',BackColour=&HFFFFFF&',  // Solid white
      gray: ',BackColour=&H80808080&',         // Semi-transparent gray
      'dark-gray': ',BackColour=&H80404040&',  // Semi-transparent dark gray
      blue: ',BackColour=&H80FF0000&',         // Semi-transparent blue (BGR)
      red: ',BackColour=&H800000FF&',          // Semi-transparent red (BGR)
      green: ',BackColour=&H8000FF00&',        // Semi-transparent green (BGR)
      yellow: ',BackColour=&H8000FFFF&',       // Semi-transparent yellow (BGR)
      purple: ',BackColour=&H80FF00FF&'        // Semi-transparent purple (BGR)
    };

    const bgColorStyle = bgColors[selectedBgColor] || '';

    // Define subtitle styles with dynamic font, font size, color, position, and background
    const styles = {
      classic: `FontName=${selectedFont},FontSize=${selectedFontSize},PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '2'},Shadow=${selectedBgColor !== 'none' ? '0' : '1'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,

      modern: `FontName=${selectedFont},FontSize=${selectedFontSize},Weight=700,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '3'},Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,

      minimal: `FontName=${selectedFont},FontSize=${selectedFontSize},PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '1'},Outline=${selectedBgColor !== 'none' ? '0' : '1'},Shadow=${selectedBgColor !== 'none' ? '0' : '2'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,

      bold: `FontName=${selectedFont},FontSize=${selectedFontSize},Weight=900,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '4'},Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,

      neon: `FontName=${selectedFont},FontSize=${selectedFontSize},Weight=700,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '2'},Shadow=${selectedBgColor !== 'none' ? '0' : '3'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,

      boxed: `FontName=${selectedFont},FontSize=${selectedFontSize},PrimaryColour=${textColor},BorderStyle=4,Outline=0,Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL + 10},MarginR=${positionSettings.MarginR + 10}${bgColorStyle || ',BackColour=&H80000000&'}`
    };

    const selectedStyle = styles[style] || styles.classic;

    console.log('Final FFmpeg style:', selectedStyle);
    console.log('Selected animation:', selectedAnimation);

    // Generate ASS subtitle file with embedded styling (more reliable than force_style)
    const generateASSContent = () => {
      // Get style parameters - use selectedFontSize from user input
      const fontWeight = { modern: 700, bold: 900, neon: 700 }[style] || 400;

      // Use user-selected outline thickness (or style default if bg is set)
      const outlineSize = selectedBgColor !== 'none' ? 0 : selectedOutlineThickness;
      const shadowSize = selectedBgColor !== 'none' ? 0 : selectedShadowDepth;
      const borderStyle = selectedBgColor !== 'none' ? 4 : ({ minimal: 1, boxed: 4 }[style] || 3);

      // Outline color mapping (ASS uses BGR format: &HBBGGRR&)
      const outlineColors = {
        'none': '&H00000000',
        'black': '&H00000000',
        'white': '&H00FFFFFF',
        'red': '&H000000FF',
        'blue': '&H00FF0000',
        'green': '&H0000FF00',
        'yellow': '&H0000FFFF',
        'purple': '&H00FF44AA'
      };
      const outlineColorValue = outlineColors[selectedOutlineColor] || '&H00000000';

      // Shadow color (ASS BackColour is used for shadow when BorderStyle=3)
      const shadowColors = {
        'none': '&H00000000',
        'black': '&H80000000',
        'white': '&H80FFFFFF',
        'red': '&H800000FF',
        'blue': '&H80FF0000'
      };

      // Get background color for ASS (AABBGGRR format)
      const assBackColors = {
        'none': '&H00000000',
        'black': '&H80000000',
        'solid-black': '&HFF000000',
        'white': '&H80FFFFFF',
        'solid-white': '&HFFFFFFFF',
        'gray': '&H80808080',
        'dark-gray': '&H80404040',
        'blue': '&H80FF0000',
        'red': '&H800000FF',
        'green': '&H8000FF00',
        'yellow': '&H8000FFFF',
        'purple': '&H80FF00FF'
      };

      // BackColour is used for background (BorderStyle=4) or shadow (BorderStyle=3)
      let backColor;
      if (selectedBgColor !== 'none') {
        backColor = assBackColors[selectedBgColor] || '&H00000000';
      } else {
        backColor = shadowColors[selectedShadowColor] || '&H80000000';
      }

      let assContent = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${selectedFont},${selectedFontSize},${textColor},&H000000FF,${outlineColorValue},${backColor},${fontWeight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outlineSize},${shadowSize},${positionSettings.Alignment},${positionSettings.MarginL},${positionSettings.MarginR},${positionSettings.MarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

      subtitleData.forEach((sub) => {
        const startTime = formatASSTime(sub.startTime);
        const endTime = formatASSTime(sub.endTime);
        assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${sub.text}\n`;
      });

      return assContent;
    };

    // Helper to format time for ASS format (H:MM:SS.CC)
    const formatASSTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const centisecs = Math.floor((seconds % 1) * 100);
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centisecs).padStart(2, '0')}`;
    };

    // Create animated subtitle filters based on selected animation
    const videoFilters = [];

    // Convert effectColor for word effects (default to yellow if not provided)
    const selectedEffectColor = effectColor || '&H00D7FF&'; // Default gold/yellow
    const effectColorHex = convertBGRtoHex(selectedEffectColor);

    if (selectedAnimation === 'none') {
      // Generate and write ASS file with embedded styling
      const assContent = generateASSContent();
      fs.writeFileSync(subtitlePath, assContent);
      console.log('Generated ASS file at:', subtitlePath);

      // Use ass filter (simpler and more reliable than subtitles with force_style)
      const escapedPath = escapeFFmpegPath(subtitlePath);
      videoFilters.push(`ass=${escapedPath}`);
    } else if (selectedAnimation === 'word-highlight') {
      // Word-by-word highlight effect (karaoke style with background box)
      console.log('Creating word-highlight filters for', subtitleData.length, 'subtitles');
      const baseColorHex = convertBGRtoHex(textColor);
      subtitleData.forEach((sub, index) => {
        const highlightFilter = createWordHighlightFilter(sub, selectedFont, baseColorHex, effectColorHex, selectedPosition, selectedBgColor, selectedFontSize, selectedWordsPerLine);
        console.log(`Word highlight filter ${index}:`, highlightFilter);
        if (highlightFilter) {
          videoFilters.push(highlightFilter);
        }
      });
    } else if (selectedAnimation === 'word-fill') {
      // Word-by-word fill effect (progressive color change that stays)
      console.log('Creating word-fill filters for', subtitleData.length, 'subtitles');
      const baseColorHex = convertBGRtoHex(textColor);
      subtitleData.forEach((sub, index) => {
        const fillFilter = createWordFillFilter(sub, selectedFont, baseColorHex, effectColorHex, selectedPosition, selectedBgColor, selectedFontSize, selectedWordsPerLine);
        console.log(`Word fill filter ${index}:`, fillFilter);
        if (fillFilter) {
          videoFilters.push(fillFilter);
        }
      });
    } else if (selectedAnimation === 'word-color') {
      // Word-by-word color change (current spoken word changes color)
      console.log('Creating word-color filters for', subtitleData.length, 'subtitles');
      const baseColorHex = convertBGRtoHex(textColor);
      subtitleData.forEach((sub, index) => {
        const colorFilter = createWordColorFilter(sub, selectedFont, baseColorHex, effectColorHex, selectedPosition, selectedBgColor, selectedFontSize, selectedWordsPerLine);
        console.log(`Word color filter ${index}:`, colorFilter);
        if (colorFilter) {
          videoFilters.push(colorFilter);
        }
      });
    } else if (selectedAnimation === 'word-reveal') {
      // Word-by-word reveal (words appear one by one as spoken)
      console.log('Creating word-reveal filters for', subtitleData.length, 'subtitles');
      const baseColorHex = convertBGRtoHex(textColor);
      subtitleData.forEach((sub, index) => {
        const revealFilter = createWordRevealFilter(sub, selectedFont, baseColorHex, selectedPosition, selectedBgColor, selectedFontSize, selectedWordsPerLine);
        console.log(`Word reveal filter ${index}:`, revealFilter);
        if (revealFilter) {
          videoFilters.push(revealFilter);
        }
      });
    } else if (selectedAnimation === 'stroke') {
      // Stroke animation (outline first, then fills with color)
      console.log('Creating stroke filters for', subtitleData.length, 'subtitles');
      const baseColorHex = convertBGRtoHex(textColor);
      subtitleData.forEach((sub, index) => {
        const strokeFilter = createStrokeFilter(sub, selectedFont, baseColorHex, effectColorHex, selectedPosition, selectedBgColor, selectedFontSize, selectedWordsPerLine);
        console.log(`Stroke filter ${index}:`, strokeFilter);
        if (strokeFilter) {
          videoFilters.push(strokeFilter);
        }
      });
    } else if (selectedAnimation === 'fire-text') {
      // Fire text effect (flickering fire colors)
      console.log('Creating fire-text filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const fireFilter = createFireTextFilter(sub, selectedFont, selectedPosition, selectedFontSize, selectedWordsPerLine);
        console.log(`Fire text filter ${index}:`, fireFilter);
        if (fireFilter) {
          videoFilters.push(fireFilter);
        }
      });
    } else if (selectedAnimation === 'ice-text') {
      // Ice text effect (shimmering ice colors)
      console.log('Creating ice-text filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const iceFilter = createIceTextFilter(sub, selectedFont, selectedPosition, selectedFontSize, selectedWordsPerLine);
        console.log(`Ice text filter ${index}:`, iceFilter);
        if (iceFilter) {
          videoFilters.push(iceFilter);
        }
      });
    } else if (selectedAnimation === 'glitch') {
      // Glitch effect (RGB splitting and jitter)
      console.log('Creating glitch filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const glitchFilter = createGlitchFilter(sub, selectedFont, selectedPosition, selectedFontSize, selectedWordsPerLine);
        console.log(`Glitch filter ${index}:`, glitchFilter);
        if (glitchFilter) {
          videoFilters.push(glitchFilter);
        }
      });
    } else {
      // Use drawtext approach for other animations
      console.log('Creating animation filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const animationFilter = createAnimationFilter(sub, selectedFont, textColor, selectedPosition, selectedBgColor, selectedAnimation, selectedFontSize, index, selectedWordsPerLine);
        console.log(`Animation filter ${index}:`, animationFilter);
        if (animationFilter) {
          videoFilters.push(animationFilter);
        }
      });
    }

    const filterComplex = videoFilters.length > 1 ? videoFilters.join(',') : videoFilters[0];
    console.log('Final filter:', filterComplex);

    // Use FFmpeg to burn subtitles into video
    const ffmpegCommand = ffmpeg(videoPath).output(outputPath);
    
    if (selectedAnimation === 'none') {
      ffmpegCommand.videoFilters(filterComplex);
    } else {
      // For animations, always use videoFilters for single subtitle
      ffmpegCommand.videoFilters(filterComplex);
    }
    
    ffmpegCommand
      .on('end', () => {
        // Clean up
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(subtitlePath)) fs.unlinkSync(subtitlePath);
        res.json({
          success: true,
          outputUrl: `/outputs/${path.basename(outputPath)}`
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        console.error('FFmpeg filter that failed:', filterComplex);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(subtitlePath)) fs.unlinkSync(subtitlePath);
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

// Speech-to-Text endpoint using Groq Whisper API
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ success: false, error: 'Groq API key not configured' });
    }

    const videoPath = req.file.path;
    const audioPath = path.join('uploads', `audio-${Date.now()}.mp3`);

    console.log('Extracting audio from video...');

    // Extract audio from video using ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .toFormat('mp3')
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(16000)
        .output(audioPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log('Audio extracted, sending to Groq Whisper...');

    // Read audio file and send to Groq Whisper API
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mp3' });

    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('timestamp_granularities[]', 'segment');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq API error:', errorText);
      throw new Error(`Groq API error: ${response.status}`);
    }

    const transcription = await response.json();
    console.log('Transcription received:', transcription);

    // Clean up files
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    // Convert Groq response to our subtitle format with word-level timing
    const subtitles = [];

    if (transcription.words && transcription.words.length > 0) {
      // Use word-level timestamps for precise sync
      // Group words into subtitle segments (roughly 5-8 words per segment)
      const wordsPerSegment = 6;
      let currentSegment = { words: [], startTime: null, endTime: null };

      transcription.words.forEach((word, index) => {
        if (currentSegment.startTime === null) {
          currentSegment.startTime = word.start;
        }
        // Clean the word - remove any special characters, newlines, etc.
        const cleanWord = word.word.replace(/[\n\r\\]/g, '').trim();
        if (cleanWord.length === 0) return; // Skip empty words

        currentSegment.words.push({
          word: cleanWord,
          start: word.start,
          end: word.end
        });
        currentSegment.endTime = word.end;

        // Create new segment every N words or at natural pauses (gaps > 0.5s)
        const nextWord = transcription.words[index + 1];
        const isLastWord = index === transcription.words.length - 1;
        const hasLongPause = nextWord && (nextWord.start - word.end > 0.5);

        if (isLastWord || currentSegment.words.length >= wordsPerSegment || hasLongPause) {
          // Create clean text without any escape characters
          const cleanText = currentSegment.words.map(w => w.word).join(' ').trim().replace(/[\n\r\\]/g, '');
          if (cleanText.length > 0) {
            subtitles.push({
              text: cleanText,
              startTime: currentSegment.startTime,
              endTime: currentSegment.endTime,
              wordTimings: currentSegment.words
            });
          }
          currentSegment = { words: [], startTime: null, endTime: null };
        }
      });
    } else if (transcription.segments) {
      // Fallback to segment-level timestamps
      transcription.segments.forEach((segment) => {
        const cleanText = segment.text.trim().replace(/[\n\r\\]/g, '');
        if (cleanText.length > 0) {
          subtitles.push({
            text: cleanText,
            startTime: segment.start,
            endTime: segment.end
          });
        }
      });
    } else if (transcription.text) {
      // Final fallback: single subtitle
      subtitles.push({
        text: transcription.text.trim(),
        startTime: 0,
        endTime: transcription.duration || 10
      });
    }

    console.log(`Generated ${subtitles.length} subtitle segments with word-level timing`);

    res.json({
      success: true,
      subtitles,
      fullText: transcription.text,
      hasWordTimings: !!(transcription.words && transcription.words.length > 0)
    });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ success: false, error: 'Transcription failed', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
