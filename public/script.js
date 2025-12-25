let subtitleCount = 0;
let currentMode = 'stt';

document.getElementById('videoFile').addEventListener('change', (e) => {
  const fileName = e.target.files[0]?.name || '';
  document.getElementById('fileName').textContent = fileName ? `Selected: ${fileName}` : '';
});

// Show/hide effect color section based on animation selection
document.querySelectorAll('input[name="animation"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const effectSection = document.getElementById('effectColorSection');
    if (e.target.value === 'word-highlight' || e.target.value === 'word-fill' || e.target.value === 'word-color' || e.target.value === 'stroke' || e.target.value === 'fire-text' || e.target.value === 'ice-text' || e.target.value === 'glitch') {
      effectSection.style.display = 'block';
      effectSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      effectSection.style.display = 'none';
    }
  });
});

// Handle subtitle mode toggle (STT vs Manual)
document.querySelectorAll('input[name="subtitleMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    currentMode = e.target.value;
    const subtitleSection = document.getElementById('subtitleSection');

    if (currentMode === 'stt') {
      // Hide manual subtitle section for STT mode
      subtitleSection.style.display = 'none';
      document.getElementById('subtitleList').innerHTML = '';
      subtitleCount = 0;
    } else {
      // Show manual subtitle section
      subtitleSection.style.display = 'block';
      // Add one subtitle field when switching to manual mode
      if (document.querySelectorAll('.subtitle-item').length === 0) {
        addSubtitle();
      }
    }
  });
});

function addSubtitle() {
  subtitleCount++;
  const subtitleList = document.getElementById('subtitleList');
  
  const subtitleItem = document.createElement('div');
  subtitleItem.className = 'subtitle-item';
  subtitleItem.id = `subtitle-${subtitleCount}`;
  
  subtitleItem.innerHTML = `
    <button class="btn-remove" onclick="removeSubtitle(${subtitleCount})">Remove</button>
    <textarea placeholder="Enter subtitle text" id="text-${subtitleCount}"></textarea>
    <div class="time-inputs">
      <input type="number" placeholder="Start time (seconds)" id="start-${subtitleCount}" step="0.1" min="0">
      <input type="number" placeholder="End time (seconds)" id="end-${subtitleCount}" step="0.1" min="0">
    </div>
  `;
  
  subtitleList.appendChild(subtitleItem);
}

function removeSubtitle(id) {
  document.getElementById(`subtitle-${id}`).remove();
}

async function processVideo() {
  const videoFile = document.getElementById('videoFile').files[0];
  const status = document.getElementById('status');
  const result = document.getElementById('result');
  const processBtn = document.getElementById('processBtn');
  const selectedMode = document.querySelector('input[name="subtitleMode"]:checked').value;

  if (!videoFile) {
    showStatus('Please select a video file', 'error');
    return;
  }

  let subtitles = [];

  // Get style settings
  const selectedStyle = document.querySelector('input[name="subtitleStyle"]:checked').value;
  const selectedFont = document.querySelector('input[name="fontFamily"]:checked').value;
  let selectedFontSize = document.querySelector('input[name="fontSize"]:checked').value;
  if (selectedFontSize === 'custom') {
    const customValue = parseInt(document.getElementById('customFontSize').value);
    selectedFontSize = (customValue >= 8 && customValue <= 200) ? customValue : 24;
  }
  const selectedColor = document.querySelector('input[name="textColor"]:checked').value;
  const selectedPosition = document.querySelector('input[name="subtitlePosition"]:checked').value;
  const selectedBgColor = document.querySelector('input[name="bgColor"]:checked').value;
  const selectedAnimation = document.querySelector('input[name="animation"]:checked').value;
  const selectedEffectColor = document.querySelector('input[name="effectColor"]:checked')?.value || '&H00D7FF&';
  const selectedWordsPerLine = parseInt(document.querySelector('input[name="wordsPerLine"]:checked').value) || 0;
  const selectedOutlineColor = document.querySelector('input[name="outlineColor"]:checked').value;
  const selectedOutlineThickness = parseInt(document.getElementById('outlineThickness').value) || 2;
  const selectedShadowColor = document.querySelector('input[name="shadowColor"]:checked').value;
  const selectedShadowDepth = parseInt(document.getElementById('shadowDepth').value) || 1;

  processBtn.disabled = true;
  result.innerHTML = '';

  // If STT mode, first transcribe the audio
  if (selectedMode === 'stt') {
    showStatus('Step 1/2: Transcribing audio with AI... This may take a moment', 'processing');
    showProgress(true);

    try {
      const transcribeFormData = new FormData();
      transcribeFormData.append('video', videoFile);

      const transcribeResponse = await fetch('http://localhost:3001/api/transcribe', {
        method: 'POST',
        body: transcribeFormData
      });

      const transcribeData = await transcribeResponse.json();

      if (!transcribeData.success) {
        showStatus(`Transcription failed: ${transcribeData.error}`, 'error');
        processBtn.disabled = false;
        showProgress(false);
        return;
      }

      subtitles = transcribeData.subtitles;
      showStatus(`Transcription complete! Found ${subtitles.length} segments. Step 2/2: Generating video...`, 'processing');

    } catch (error) {
      showStatus(`Transcription error: ${error.message}`, 'error');
      processBtn.disabled = false;
      showProgress(false);
      return;
    }
  } else {
    // Manual mode - get subtitles from form
    const subtitleItems = document.querySelectorAll('.subtitle-item');

    subtitleItems.forEach(item => {
      const id = item.id.split('-')[1];
      const text = document.getElementById(`text-${id}`).value;
      const startTime = parseFloat(document.getElementById(`start-${id}`).value);
      const endTime = parseFloat(document.getElementById(`end-${id}`).value);

      if (text && !isNaN(startTime) && !isNaN(endTime)) {
        subtitles.push({ text, startTime, endTime });
      }
    });

    if (subtitles.length === 0) {
      showStatus('Please add at least one subtitle', 'error');
      processBtn.disabled = false;
      return;
    }

    showStatus('Processing video... This may take a few minutes', 'processing');
    showProgress(true);
  }

  // Now generate the video with subtitles
  const formData = new FormData();
  formData.append('video', videoFile);
  formData.append('subtitles', JSON.stringify(subtitles));
  formData.append('style', selectedStyle);
  formData.append('font', selectedFont);
  formData.append('fontSize', selectedFontSize);
  formData.append('color', selectedColor);
  formData.append('position', selectedPosition);
  formData.append('bgColor', selectedBgColor);
  formData.append('animation', selectedAnimation);
  formData.append('effectColor', selectedEffectColor);
  formData.append('wordsPerLine', selectedWordsPerLine);
  formData.append('outlineColor', selectedOutlineColor);
  formData.append('outlineThickness', selectedOutlineThickness);
  formData.append('shadowColor', selectedShadowColor);
  formData.append('shadowDepth', selectedShadowDepth);

  try {
    const response = await fetch('http://localhost:3001/api/add-subtitles', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      showStatus('Video processed successfully!', 'success');
      result.innerHTML = `
        <h3>Your video is ready:</h3>
        <video controls>
          <source src="http://localhost:3001${data.outputUrl}" type="video/mp4">
        </video>
        <p><a href="http://localhost:3001${data.outputUrl}" download>Download Video</a></p>
      `;
    } else {
      showStatus(`Error: ${data.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    processBtn.disabled = false;
    showProgress(false);
  }
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status-message ' + type;
}

function showProgress(show) {
  const progressContainer = document.getElementById('progressContainer');
  if (show) {
    progressContainer.style.display = 'block';
  } else {
    progressContainer.style.display = 'none';
  }
}

// Slider value display updates
document.getElementById('outlineThickness').addEventListener('input', (e) => {
  document.getElementById('outlineThicknessValue').textContent = e.target.value;
});

document.getElementById('shadowDepth').addEventListener('input', (e) => {
  document.getElementById('shadowDepthValue').textContent = e.target.value;
});

// Initialize: STT mode is default, subtitle section is hidden by default in HTML
