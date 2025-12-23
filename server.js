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

// Helper function to create animation filters
function createAnimationFilter(subtitle, font, color, position, bgColor, animation, fontSize, index) {
  const { text, startTime, endTime } = subtitle;
  const duration = endTime - startTime;

  // Convert color from &HBBGGRR& format to RGB hex
  const colorHex = color.replace('&H', '').replace('&', '');
  const b = parseInt(colorHex.substr(0, 2), 16);
  const g = parseInt(colorHex.substr(2, 2), 16);
  const r = parseInt(colorHex.substr(4, 2), 16);
  const textColor = `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

  // Position mapping for drawtext
  const positions = {
    'top-left': { x: '50', y: '50' },
    'top-center': { x: '(w-text_w)/2', y: '50' },
    'top-right': { x: 'w-text_w-50', y: '50' },
    'middle-left': { x: '50', y: '(h-text_h)/2' },
    'middle-center': { x: '(w-text_w)/2', y: '(h-text_h)/2' },
    'middle-right': { x: 'w-text_w-50', y: '(h-text_h)/2' },
    'bottom-left': { x: '50', y: 'h-text_h-50' },
    'bottom-center': { x: '(w-text_w)/2', y: 'h-text_h-50' },
    'bottom-right': { x: 'w-text_w-50', y: 'h-text_h-50' }
  };

  const pos = positions[position] || positions['bottom-center'];

  // Background color mapping for drawtext box (uses 0xRRGGBBAA format)
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
  const escapedText = text.replace(/'/g, "\\'").replace(/:/g, "\\:");
  const escapedFont = font.replace(/'/g, "\\'").replace(/:/g, "\\:");

  // Animation effects - simplified for stability
  switch (animation) {
    case 'fade-in':
      // Fade in over 0.5 seconds using alpha expression
      return `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}@0xff:x=${pos.x}:y=${pos.y}:alpha='if(lt(t-${startTime},0.5),(t-${startTime})/0.5,1)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`;

    case 'slide-up':
      // Slide up from bottom of screen to target position using linear interpolation
      // y = start + (end - start) * progress, where progress is clamped 0-1
      return `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y='(h-50)+((${pos.y})-(h-50))*min(1\\,(t-${startTime})/0.8)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`;

    case 'slide-left':
      // Slide left from right side of screen to target position using linear interpolation
      // x = start + (end - start) * progress, where progress is clamped 0-1
      return `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x='(w)+((${pos.x})-(w))*min(1\\,(t-${startTime})/0.8)':y=${pos.y}:borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`;

    case 'bounce':
      // Bounce effect - oscillate up/down from target position for first 0.5 seconds
      // Wrap pos.y in parentheses to handle expression positions like (h-text_h)/2
      return `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y='(${pos.y})-if(lt(t-${startTime}\\,0.5)\\,30*sin(6*(t-${startTime}))\\,0)':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`;

    case 'typewriter':
      // Typewriter effect: text appears progressively using alpha fade
      // Duration scales with text length for a typing-like appearance
      const typeDuration = Math.min(duration * 0.8, Math.max(0.5, text.length * 0.08));
      return `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:alpha='min(1\\,(t-${startTime})/${typeDuration})':borderw=2:bordercolor=black${boxStyle}:enable='between(t,${startTime},${endTime})'`;
    
    default:
      return null;
  }
}

app.post('/api/add-subtitles', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }
    
    const { subtitles, style, font, fontSize, color, position, bgColor, animation } = req.body;
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

    console.log('Processing video with:', { style, font: selectedFont, fontSize: selectedFontSize, color: selectedColor, position: selectedPosition, bgColor: selectedBgColor, animation: selectedAnimation });

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
      const outlineSize = selectedBgColor !== 'none' ? 0 : ({ classic: 2, modern: 3, minimal: 1, bold: 4, neon: 2, boxed: 0 }[style] || 2);
      const shadowSize = selectedBgColor !== 'none' ? 0 : ({ classic: 1, minimal: 2, neon: 3 }[style] || 0);
      const borderStyle = selectedBgColor !== 'none' ? 4 : ({ minimal: 1, boxed: 4 }[style] || 3);

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
      const backColor = assBackColors[selectedBgColor] || '&H00000000';

      let assContent = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${selectedFont},${selectedFontSize},${textColor},&H000000FF,&H00000000,${backColor},${fontWeight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outlineSize},${shadowSize},${positionSettings.Alignment},${positionSettings.MarginL},${positionSettings.MarginR},${positionSettings.MarginV},1

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

    if (selectedAnimation === 'none') {
      // Generate and write ASS file with embedded styling
      const assContent = generateASSContent();
      fs.writeFileSync(subtitlePath, assContent);
      console.log('Generated ASS file at:', subtitlePath);

      // Use ass filter (simpler and more reliable than subtitles with force_style)
      const escapedPath = escapeFFmpegPath(subtitlePath);
      videoFilters.push(`ass=${escapedPath}`);
    } else {
      // Use drawtext approach for animations
      console.log('Creating animation filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const animationFilter = createAnimationFilter(sub, selectedFont, textColor, selectedPosition, selectedBgColor, selectedAnimation, selectedFontSize, index);
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
