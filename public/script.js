let subtitleCount = 0;

document.getElementById('videoFile').addEventListener('change', (e) => {
  const fileName = e.target.files[0]?.name || '';
  document.getElementById('fileName').textContent = fileName ? `Selected: ${fileName}` : '';
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
  
  if (!videoFile) {
    showStatus('Please select a video file', 'error');
    return;
  }
  
  const subtitles = [];
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
    return;
  }
  
  const selectedStyle = document.querySelector('input[name="subtitleStyle"]:checked').value;
  const selectedFont = document.querySelector('input[name="fontFamily"]:checked').value;

  // Handle font size - check if custom is selected
  let selectedFontSize = document.querySelector('input[name="fontSize"]:checked').value;
  if (selectedFontSize === 'custom') {
    const customValue = parseInt(document.getElementById('customFontSize').value);
    // Validate custom value is within range (8-108), default to 24 if invalid
    selectedFontSize = (customValue >= 8 && customValue <= 108) ? customValue : 24;
  }
  const selectedColor = document.querySelector('input[name="textColor"]:checked').value;
  const selectedPosition = document.querySelector('input[name="subtitlePosition"]:checked').value;
  const selectedBgColor = document.querySelector('input[name="bgColor"]:checked').value;
  const selectedAnimation = document.querySelector('input[name="animation"]:checked').value;

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
  
  processBtn.disabled = true;
  showStatus('Processing video... This may take a few minutes', 'processing');
  showProgress(true);
  result.innerHTML = '';

  try {
    const response = await fetch('http://localhost:3000/api/add-subtitles', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      showStatus('Video processed successfully!', 'success');
      result.innerHTML = `
        <h3>Your video is ready:</h3>
        <video controls>
          <source src="http://localhost:3000${data.outputUrl}" type="video/mp4">
        </video>
        <p><a href="http://localhost:3000${data.outputUrl}" download>Download Video</a></p>
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

// Add initial subtitle
addSubtitle();
