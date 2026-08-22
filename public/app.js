// ============================================================
// PVD 311 — Client Logic (Step Wizard v4, generic categories)
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyClljpzQrR9-LGvD_xtWtOfcTebTAO0P80",
  authDomain: "pvd-snow-report.firebaseapp.com",
  projectId: "pvd-snow-report",
  storageBucket: "pvd-snow-report.firebasestorage.app",
  messagingSenderId: "224841506687",
  appId: "1:224841506687:web:1626643194b097db79844a",
  measurementId: "G-KKLML5QH3L"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const storage = firebase.storage();
const analytics = firebase.analytics();
function logEvent(name, params) {
  try { analytics.logEvent(name, params); } catch(e) {}
}

// --- Categories (from /categories.js, generated from shared/categories.ts) ---
const ALL_CATEGORIES = window.PVD_CATEGORIES || [];
const CATEGORY_BY_KEY = Object.fromEntries(ALL_CATEGORIES.map(c => [c.key, c]));
const CATEGORY_LABELS = Object.fromEntries(ALL_CATEGORIES.map(c => [c.key, c.label]));

// Seasonal categories only show in season (winter = Nov–Mar).
function inSeason(c) {
  if (!c.seasonal) return true;
  const m = new Date().getMonth(); // 0-based
  return c.seasonal === 'winter' ? (m >= 10 || m <= 2) : true;
}
const VISIBLE_CATEGORIES = ALL_CATEGORIES.filter(inSeason);

// Per-category follow-up questions rendered on the Review step (`extra` on the report).
// Keys match the `from: 'extra.<key>'` sources in shared/categories.ts.
const EXTRA_QUESTIONS = {
  // Option labels mirror the portal's cop_size choices (see scripts/PORTAL-RESEARCH-ADDENDUM-2026-08.md).
  size: { label: 'How big is the pothole?', type: 'choice', options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
  cartIssue: { label: 'What is the issue with your carts?', type: 'choice',
    options: ['I did not receive my new carts.', 'My old carts were not removed', 'Other'] },
  animalType: { label: 'What kind of animal?', type: 'choice', options: ['Wildlife', 'Domestic'] },
  vehicleDetails: { label: 'Vehicle details (make, color, plate if visible)', type: 'text', placeholder: 'e.g. silver Honda Civic, RI plate ABC-123' },
};

// --- DOM refs ---
const wizard = document.getElementById('wizard');
const steps = wizard.querySelectorAll('.step');
const progressFill = document.getElementById('progressFill');
const progressSteps = document.querySelectorAll('.progress-step');
const backBtn = document.getElementById('backBtn');
const nextBtn = document.getElementById('nextBtn');
const categoryBtns = document.getElementById('categoryBtns');
const photoInput = document.getElementById('photoInput');
const photoCaptureBtn = document.getElementById('photoCaptureBtn');
const previewImg = document.getElementById('previewImg');
const photoRetake = document.getElementById('photoRetake');
const photoExifStatus = document.getElementById('photoExifStatus');
const locationStatus = document.getElementById('locationStatus');
const detectBtn = document.getElementById('detectLocationBtn');
const addressInput = document.getElementById('addressInput');
const latLngEl = document.getElementById('latLng');
const locationSection = document.getElementById('locationSection');
const locationHeading = document.getElementById('locationHeading');
const descriptionInput = document.getElementById('descriptionInput');
const extraQuestions = document.getElementById('extraQuestions');
const photoDesc = document.getElementById('photoDesc');
const nameInput = document.getElementById('nameInput');
const emailInput = document.getElementById('emailInput');
const reviewCategory = document.getElementById('reviewCategory');
const reviewAddress = document.getElementById('reviewAddress');
const reviewPhoto = document.getElementById('reviewPhoto');
const overlay = document.getElementById('submittingOverlay');
const confirmation = document.getElementById('confirmationScreen');
const confirmCategory = document.getElementById('confirmCategory');
const confirmAddress = document.getElementById('confirmAddress');
const submitAnother = document.getElementById('submitAnother');
const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');
const errorDismiss = document.getElementById('errorDismiss');

const pvdWarning = document.getElementById('pvdWarning');

const PVD_BOUNDS = { minLat: 41.772, maxLat: 41.871, minLng: -71.473, maxLng: -71.370 };

function checkProvidenceBounds() {
  if (currentLat != null && currentLng != null) {
    const inside = currentLat >= PVD_BOUNDS.minLat && currentLat <= PVD_BOUNDS.maxLat &&
                   currentLng >= PVD_BOUNDS.minLng && currentLng <= PVD_BOUNDS.maxLng;
    if (!inside) {
      pvdWarning.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> <span>This location appears to be outside Providence. We only submit reports within city limits.</span>';
      pvdWarning.classList.add('visible');
      return;
    }
  }
  pvdWarning.classList.remove('visible');
}

const TOTAL_STEPS = 4;
let currentStep = 0;

// --- State ---
let selectedCategory = null;
let photoDataUrl = null;
let currentLat = null;
let currentLng = null;
let hasExifGps = false;

// --- Location state machine ---
function setLocationState(state) {
  locationSection.classList.remove('state-confirmed', 'state-needs-input', 'state-detecting', 'state-detect-failed');
  if (state) {
    locationSection.classList.add('state-' + state);
  }
  if (state === 'confirmed') {
    locationHeading.textContent = 'Confirm location';
  } else {
    locationHeading.textContent = 'Set location';
  }
}

// --- Step navigation ---
function photoRequired() {
  const c = CATEGORY_BY_KEY[selectedCategory];
  return !c || c.photoRequired !== false;
}

function renderCategoryPicker() {
  const check = '<span class="cat-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#0a1628" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5,6 5,8.5 9.5,3.5"/></svg></span>';
  categoryBtns.innerHTML = VISIBLE_CATEGORIES.map(c =>
    `<button type="button" class="category-btn${c.key === 'unsure' ? ' category-btn-unsure' : ''}" data-category="${c.key}">` +
    `<span class="cat-icon">${c.icon}</span><span class="cat-text">${c.label}</span>${check}</button>`
  ).join('');
}

function renderExtraQuestions() {
  const c = CATEGORY_BY_KEY[selectedCategory];
  const keys = (c && c.extra || []).filter(k => EXTRA_QUESTIONS[k]);
  extraQuestions.innerHTML = '';
  extraQuestions.hidden = keys.length === 0;
  keys.forEach(k => {
    const q = EXTRA_QUESTIONS[k];
    const id = `extra_${k}`;
    const label = `<label class="field-label" for="${id}">${q.label}</label>`;
    if (q.type === 'choice') {
      extraQuestions.insertAdjacentHTML('beforeend', label +
        `<select class="text-input" id="${id}" data-extra="${k}">` +
        q.options.map(o => `<option value="${o}">${o}</option>`).join('') + '</select>');
    } else {
      extraQuestions.insertAdjacentHTML('beforeend', label +
        `<input type="text" class="text-input" id="${id}" data-extra="${k}" placeholder="${q.placeholder || ''}">`);
    }
  });
}

function collectExtra() {
  const out = {};
  extraQuestions.querySelectorAll('[data-extra]').forEach(el => {
    const v = el.value.trim();
    if (v) out[el.dataset.extra] = v;
  });
  return Object.keys(out).length ? out : null;
}

function goToStep(n) {
  logEvent('wizard_step', { step: n });
  currentStep = n;
  steps.forEach((s, i) => s.classList.toggle('active', i === n));
  progressSteps.forEach((s, i) => {
    s.classList.toggle('active', i === n);
    s.classList.toggle('done', i < n);
  });
  progressFill.style.width = `${((n + 1) / TOTAL_STEPS) * 100}%`;

  backBtn.classList.toggle('hidden', n === 0);
  errorBanner.classList.remove('visible');

  if (n === TOTAL_STEPS - 1) {
    nextBtn.textContent = 'Submit Report';
    populateReview();
  } else if (n === 1 && !photoDataUrl && !photoRequired()) {
    nextBtn.textContent = 'Skip photo';
  } else {
    nextBtn.textContent = 'Next';
  }
  if (n === 1) {
    photoDesc.textContent = photoRequired()
      ? "Your photo's location data will auto-detect the address."
      : "Optional for this issue — a photo helps, and its location data auto-detects the address.";
  }

  validateStep();
  window.scrollTo(0, 0);
}

// #1: Tappable progress steps — only completed steps
document.querySelector('.progress-steps').addEventListener('click', (e) => {
  const btn = e.target.closest('.progress-step');
  if (!btn || !btn.classList.contains('done')) return;
  goToStep(parseInt(btn.dataset.step, 10));
});

// #5: Tappable review rows
document.querySelector('.review-card').addEventListener('click', (e) => {
  const row = e.target.closest('.review-row-btn');
  if (!row) return;
  goToStep(parseInt(row.dataset.goto, 10));
});

function validateStep() {
  let valid = false;
  switch (currentStep) {
    case 0: valid = !!selectedCategory; break;
    case 1: valid = !!photoDataUrl || !photoRequired(); break;
    case 2: valid = addressInput.value.trim().length > 0; break;
    case 3: valid = true; break;
  }
  nextBtn.disabled = !valid;
}

function populateReview() {
  reviewCategory.textContent = CATEGORY_LABELS[selectedCategory] || selectedCategory;
  reviewAddress.textContent = addressInput.value.trim();
  reviewPhoto.src = photoDataUrl || '';
  reviewPhoto.parentElement.hidden = !photoDataUrl;
  renderExtraQuestions();
}

nextBtn.addEventListener('click', async () => {
  if (nextBtn.disabled) return;
  if (currentStep < TOTAL_STEPS - 1) {
    goToStep(currentStep + 1);
  } else {
    await submitReport();
  }
});

backBtn.addEventListener('click', () => {
  if (currentStep > 0) goToStep(currentStep - 1);
});

// --- Step 0: Category (#3: auto-advance) ---
categoryBtns.addEventListener('click', (e) => {
  const btn = e.target.closest('.category-btn');
  if (!btn) return;
  categoryBtns.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedCategory = btn.dataset.category;
  logEvent('select_category', { category: selectedCategory });
  renderExtraQuestions();
  validateStep();

  // Auto-advance after brief delay
  setTimeout(() => {
    if (currentStep === 0 && selectedCategory) goToStep(1);
  }, 300);
});

// --- Step 1: Photo capture + EXIF GPS ---
photoInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const [exifGps, dataUrl] = await Promise.all([
    readExifGps(file).catch(() => null),
    compressImage(file, 800, 0.7).catch(() => fileToDataUrl(file))
  ]);

  photoDataUrl = dataUrl;
  previewImg.src = dataUrl;
  photoCaptureBtn.classList.add('has-photo');
  logEvent('photo_captured', { has_exif_gps: !!exifGps });

  // #4: Show EXIF status on the photo step
  if (exifGps) {
    hasExifGps = true;
    currentLat = exifGps.lat;
    currentLng = exifGps.lng;
    latLngEl.textContent = `${currentLat.toFixed(5)}, ${currentLng.toFixed(5)}`;
    locationStatus.textContent = 'Location detected from photo.';
    photoExifStatus.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,7 6,10 11,4"/></svg> Photo + location attached';
    photoExifStatus.classList.remove('no-gps');
    setLocationState('confirmed');
    checkProvidenceBounds();
    reverseGeocode(currentLat, currentLng);
  } else {
    hasExifGps = false;
    pvdWarning.classList.remove('visible');
    locationStatus.textContent = 'No location in photo. Use Detect or type an address.';
    photoExifStatus.textContent = 'Photo attached — no location data';
    photoExifStatus.classList.add('no-gps');
    setLocationState('needs-input');
  }

  if (currentStep === 1) nextBtn.textContent = 'Next';
  validateStep();
});

photoRetake.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  photoDataUrl = null;
  hasExifGps = false;
  photoInput.value = '';
  previewImg.src = '';
  photoCaptureBtn.classList.remove('has-photo');
  validateStep();
  photoInput.click();
});

// --- Image compression → base64 ---
function compressImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * (maxWidth / w));
          w = maxWidth;
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Minimal EXIF GPS parser ---
function readExifGps(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const result = parseExifGps(new DataView(e.target.result));
        if (result) resolve(result);
        else reject(new Error('No GPS data'));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file.slice(0, 131072));
  });
}

function parseExifGps(view) {
  if (view.getUint16(0) !== 0xFFD8) return null;

  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) break;
    if ((marker & 0xFF00) !== 0xFF00) return null;
    offset += 2 + view.getUint16(offset + 2);
  }

  const app1Start = offset + 4;
  if (app1Start + 6 > view.byteLength) return null;
  if (view.getUint32(app1Start) !== 0x45786966 || view.getUint16(app1Start + 4) !== 0x0000) return null;

  const tiffStart = app1Start + 6;
  const bigEndian = view.getUint16(tiffStart) === 0x4D4D;
  const g16 = (o) => view.getUint16(tiffStart + o, !bigEndian);
  const g32 = (o) => view.getUint32(tiffStart + o, !bigEndian);

  let ifdOffset = g32(4);
  const ifdCount = g16(ifdOffset);
  let gpsIfdOffset = null;

  for (let i = 0; i < ifdCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (g16(entryOffset) === 0x8825) {
      gpsIfdOffset = g32(entryOffset + 8);
      break;
    }
  }

  if (gpsIfdOffset === null) return null;

  const gpsCount = g16(gpsIfdOffset);
  const tags = {};
  for (let i = 0; i < gpsCount; i++) {
    const eo = gpsIfdOffset + 2 + i * 12;
    const tag = g16(eo);
    const type = g16(eo + 2);
    const count = g32(eo + 4);
    const valOffset = g32(eo + 8);

    if (type === 2 && count <= 4) {
      tags[tag] = String.fromCharCode(view.getUint8(tiffStart + eo + 8));
    } else if (type === 2) {
      let s = '';
      for (let j = 0; j < count - 1; j++) s += String.fromCharCode(view.getUint8(tiffStart + valOffset + j));
      tags[tag] = s;
    } else if (type === 5 && count === 3) {
      tags[tag] = readRationals(view, tiffStart + valOffset, bigEndian);
    }
  }

  if (!tags[2] || !tags[4]) return null;

  let lat = dmsToDecimal(tags[2]);
  let lng = dmsToDecimal(tags[4]);
  if (tags[1] === 'S') lat = -lat;
  if (tags[3] === 'W') lng = -lng;

  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function readRationals(view, offset, bigEndian) {
  const le = !bigEndian;
  const result = [];
  for (let i = 0; i < 3; i++) {
    const num = view.getUint32(offset + i * 8, le);
    const den = view.getUint32(offset + i * 8 + 4, le);
    result.push(den === 0 ? 0 : num / den);
  }
  return result;
}

function dmsToDecimal([d, m, s]) {
  return d + m / 60 + s / 3600;
}

// --- Reverse geocoding (ArcGIS — matches the city's 311 portal geocoder) ---
async function reverseGeocode(lat, lng) {
  try {
    const resp = await fetch(
      `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${lng},${lat}&featureTypes=StreetAddress,StreetName,StreetInt&f=pjson`
    );
    const data = await resp.json();
    if (data.address) {
      const a = data.address;
      addressInput.value = a.Address || a.ShortLabel || a.Match_addr || '';
      validateStep();
    }
    if (!addressInput.value.trim()) {
      locationStatus.textContent = 'Could not look up address. Please type it in.';
      setLocationState('needs-input');
      addressInput.focus();
    }
  } catch (err) {
    console.error('Reverse geocode failed:', err);
    locationStatus.textContent = 'Could not look up address. Please type it in.';
    setLocationState('needs-input');
    addressInput.focus();
  }
}

// --- Step 2: Location fallback ---
detectBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    locationStatus.textContent = 'Geolocation not supported by this browser.';
    setLocationState('detect-failed');
    addressInput.focus();
    return;
  }

  detectBtn.classList.add('detecting');
  setLocationState('detecting');
  latLngEl.textContent = 'Detecting…';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentLat = pos.coords.latitude;
      currentLng = pos.coords.longitude;
      latLngEl.textContent = `${currentLat.toFixed(5)}, ${currentLng.toFixed(5)}`;
      detectBtn.classList.remove('detecting');
      locationStatus.textContent = 'Location detected from GPS.';
      logEvent('location_detected', { method: 'gps' });
      setLocationState('confirmed');
      checkProvidenceBounds();
      reverseGeocode(currentLat, currentLng);
    },
    () => {
      detectBtn.classList.remove('detecting');
      locationStatus.textContent = 'Could not access location. Enter an address instead.';
      setLocationState('detect-failed');
      addressInput.focus();
    },
    { enableHighAccuracy: true, timeout: 20000 }
  );
});

addressInput.addEventListener('input', validateStep);

// --- Step 3: Contact toggle ---
// --- #7: Error banner ---
errorDismiss.addEventListener('click', () => {
  errorBanner.classList.remove('visible');
});

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.add('visible');
}

// --- Photo upload to Cloud Storage ---
async function uploadPhoto(dataUrl) {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const path = `reports/${timestamp}_${randomId}.jpg`;
  const ref = storage.ref(path);
  await ref.putString(dataUrl, 'data_url', { contentType: 'image/jpeg' });
  return ref.getDownloadURL();
}

// --- Submit ---
async function submitReport() {
  overlay.classList.add('visible');
  errorBanner.classList.remove('visible');

  if (!navigator.onLine) {
    overlay.classList.remove('visible');
    showError('No internet connection. Please try again.');
    return;
  }

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 30000)
    );

    let photoUrl = null;
    if (photoDataUrl) {
      photoUrl = await Promise.race([uploadPhoto(photoDataUrl), timeout]);
    }

    await Promise.race([db.collection('reports').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      category: selectedCategory,
      address: addressInput.value.trim(),
      lat: currentLat,
      lng: currentLng,
      description: descriptionInput.value.trim() || null,
      extra: collectExtra(),
      photo: photoUrl,
      reporterName: nameInput.value.trim() || null,
      reporterEmail: emailInput.value.trim() || null,
      status: 'pending',
      statusDetail: null,
      portalCaseId: null,
      statusUpdatedAt: null
    }), timeout]);

    overlay.classList.remove('visible');
    wizard.style.display = 'none';
    document.getElementById('wizardNav').style.display = 'none';
    document.getElementById('progressBar').style.display = 'none';

    // #9: Populate confirmation summary
    confirmCategory.textContent = CATEGORY_LABELS[selectedCategory] || selectedCategory;
    confirmAddress.textContent = addressInput.value.trim();
    confirmation.classList.add('visible');
    const locationMethod = hasExifGps ? 'photo_exif'
      : (currentLat && currentLng) ? 'device_gps'
      : 'manual_entry';
    logEvent('report_submitted', { category: selectedCategory, location_method: locationMethod });

  } catch (err) {
    console.error('Submission failed:', err);
    overlay.classList.remove('visible');
    logEvent('submit_error', { error: err.message || String(err) });
    showError(err.message === 'timeout'
      ? 'Submission timed out. Please check your connection and try again.'
      : 'Submission failed. Please check your connection and try again.');
  }
}

// --- Share buttons ---
const shareNativeBtn = document.getElementById('shareNative');
const shareCopyBtn = document.getElementById('shareCopy');

if (!navigator.share) {
  shareNativeBtn.style.display = 'none';
}

shareNativeBtn.addEventListener('click', () => {
  const issueLabel = selectedCategory === 'unshoveled_sidewalk'
    ? 'an unshoveled sidewalk'
    : 'an unplowed street';
  const shareText = `I just reported ${issueLabel} in Providence using pvdsnow.org \u2014 takes 30 seconds from your phone.`;
  logEvent('share_click', { method: 'native' });
  navigator.share({ text: shareText, url: 'https://pvdsnow.org' }).catch(() => {});
});

shareCopyBtn.addEventListener('click', () => {
  logEvent('share_click', { method: 'copy_link' });
  navigator.clipboard.writeText('https://pvdsnow.org').then(() => {
    shareCopyBtn.textContent = 'Copied!';
    setTimeout(() => {
      shareCopyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> Copy link';
    }, 2000);
  });
});

// --- Submit another ---
submitAnother.addEventListener('click', () => {
  selectedCategory = null;
  photoDataUrl = null;
  currentLat = null;
  currentLng = null;
  hasExifGps = false;

  categoryBtns.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));
  photoInput.value = '';
  previewImg.src = '';
  photoCaptureBtn.classList.remove('has-photo');
  addressInput.value = '';
  latLngEl.textContent = '';
  locationStatus.textContent = 'Checking photo for location data...';
  setLocationState(null);
  descriptionInput.value = '';
  nameInput.value = '';
  emailInput.value = '';
  extraQuestions.innerHTML = '';
  extraQuestions.hidden = true;
  errorBanner.classList.remove('visible');
  pvdWarning.classList.remove('visible');

  wizard.style.display = '';
  document.getElementById('wizardNav').style.display = '';
  document.getElementById('progressBar').style.display = '';
  confirmation.classList.remove('visible');
  shareCopyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> Copy link';

  goToStep(0);
});

// --- Init ---
renderCategoryPicker();
goToStep(0);
