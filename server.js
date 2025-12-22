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

// Helper function to create animation filters
function createAnimationFilter(subtitle, font, color, position, bgColor, animation, style, index) {
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
  
  // Get font size based on selected style (matching the subtitle styles)
  const styleFontSizes = {
    classic: 48,
    modern: 56,
    minimal: 44,
    bold: 64,
    neon: 52,
    boxed: 48
  };
  
  // Use a larger base font size for animations, or match the style
  const fontSize = styleFontSizes[style] || 48;
  const escapedText = text.replace(/'/g, "\\'").replace(/:/g, "\\:");
  
  // Animation effects - simplified for stability
  switch (animation) {
    case 'fade-in':
      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'slide-up':
      // Simplified slide up - start from bottom and move to position
      const slideStartY = 'h-50';
      const slideEndY = pos.y;
      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y='if(lt(t,${startTime + 0.8}),${slideStartY}-(${slideStartY}-(${slideEndY}))*(t-${startTime})/0.8,${slideEndY})':borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'slide-left':
      // Simplified slide left - start from right and move to position
      const slideStartX = 'w-50';
      const slideEndX = pos.x;
      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${textColor}:x='if(lt(t,${startTime + 0.8}),${slideStartX}-(${slideStartX}-(${slideEndX}))*(t-${startTime})/0.8,${slideEndX})':y=${pos.y}:borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'zoom-in':
      // Simplified zoom - start small and grow
      return `drawtext=text='${escapedText}':fontsize='if(lt(t,${startTime + 0.6}),20+(${fontSize}-20)*(t-${startTime})/0.6,${fontSize})':fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'bounce':
      // Simplified bounce - just a basic up/down movement
      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y='${pos.y}-if(lt(t,${startTime + 0.5}),30*sin(6*(t-${startTime})),0)':borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'pulse':
      // Simplified pulse - basic size variation
      return `drawtext=text='${escapedText}':fontsize='${fontSize}+if(lt(mod(t-${startTime},1),0.5),8,-8)':fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    case 'typewriter':
      // Static text for typewriter (complex text manipulation causes crashes)
      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:borderw=2:bordercolor=black:enable='between(t,${startTime},${endTime})'`;
    
    default:
      return null;
  }
}

app.post('/api/add-subtitles', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }
    
    const { subtitles, style, font, color, position, bgColor, animation } = req.body;
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

    // Get selected options or defaults
    const selectedFont = font || 'Arial';
    const selectedColor = color || 'white';
    const selectedPosition = position || 'bottom-center';
    const selectedBgColor = bgColor || 'none';
    const selectedAnimation = animation || 'none';

    console.log('Processing video with:', { style, font: selectedFont, color: selectedColor, position: selectedPosition, bgColor: selectedBgColor, animation: selectedAnimation });

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

    // Define subtitle styles with dynamic font, color, position, and background
    const styles = {
      classic: `FontName=${selectedFont},FontSize=24,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '2'},Shadow=${selectedBgColor !== 'none' ? '0' : '1'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,
      
      modern: `FontName=${selectedFont},FontSize=28,Weight=700,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '3'},Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,
      
      minimal: `FontName=${selectedFont},FontSize=22,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '1'},Outline=${selectedBgColor !== 'none' ? '0' : '1'},Shadow=${selectedBgColor !== 'none' ? '0' : '2'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,
      
      bold: `FontName=${selectedFont},FontSize=32,Weight=900,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '4'},Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,
      
      neon: `FontName=${selectedFont},FontSize=26,Weight=700,PrimaryColour=${textColor},OutlineColour=&H000000&,BorderStyle=${selectedBgColor !== 'none' ? '4' : '3'},Outline=${selectedBgColor !== 'none' ? '0' : '2'},Shadow=${selectedBgColor !== 'none' ? '0' : '3'},Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL},MarginR=${positionSettings.MarginR}${bgColorStyle}`,
      
      boxed: `FontName=${selectedFont},FontSize=24,PrimaryColour=${textColor},BorderStyle=4,Outline=0,Shadow=0,Alignment=${positionSettings.Alignment},MarginV=${positionSettings.MarginV},MarginL=${positionSettings.MarginL + 10},MarginR=${positionSettings.MarginR + 10}${bgColorStyle || ',BackColour=&H80000000&'}`
    };

    const selectedStyle = styles[style] || styles.classic;

    console.log('Final FFmpeg style:', selectedStyle);
    console.log('Selected animation:', selectedAnimation);

    // Create animated subtitle filters based on selected animation
    const videoFilters = [];
    
    if (selectedAnimation === 'none') {
      // Use traditional subtitle approach for no animation
      videoFilters.push(`subtitles=${srtPath}:force_style='${selectedStyle}'`);
    } else {
      // Use drawtext approach for animations
      console.log('Creating animation filters for', subtitleData.length, 'subtitles');
      subtitleData.forEach((sub, index) => {
        const animationFilter = createAnimationFilter(sub, selectedFont, textColor, selectedPosition, selectedBgColor, selectedAnimation, style, index);
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
        fs.unlinkSync(videoPath);
        fs.unlinkSync(srtPath);
        res.json({ 
          success: true, 
          outputUrl: `/outputs/${path.basename(outputPath)}` 
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        console.error('FFmpeg command that failed:', `subtitles=${srtPath}:force_style='${selectedStyle}'`);
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
