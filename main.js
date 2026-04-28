/* ================= ASSET BASE PATH ================= */
const MEDIA = "Media/";

/* ================= VIDEO SETS ================= */
const dayVideos   = [`${MEDIA}HomeBanner2.mp4`];
const nightVideos = [`${MEDIA}HomeBanner1.mp4`];

/* Mobile-specific video sets (used only on small screens)
   Portrait + landscape can use different sources.

   NOTE: Landscape filenames are placeholders; add the files (or rename here) to match your media folder.
*/
const mobileDayVideosPortrait     = [`${MEDIA}HomeBanner2_Mobile.mp4`];
const mobileNightVideosPortrait   = [`${MEDIA}HomeBanner1_Mobile.mp4`];
const mobileDayVideosLandscape    = [];
const mobileNightVideosLandscape  = [];

function isLandscape(){
  return !!(window.matchMedia && window.matchMedia("(orientation: landscape)").matches);
}

function isMobileViewport(){
  if (!window.matchMedia) return false;
  return window.matchMedia("(max-width: 720px), (max-height: 520px) and (orientation: landscape) and (hover: none) and (pointer: coarse)").matches;
}

function getVideoList(mode){
  const mobile = isMobileViewport();
  const fallback = (mode === "day") ? dayVideos : nightVideos;

  if (mobile){
    const land = isLandscape();
    const portrait = (mode === "day") ? mobileDayVideosPortrait : mobileNightVideosPortrait;
    const landscape = (mode === "day") ? mobileDayVideosLandscape : mobileNightVideosLandscape;
    const preferred = (land ? landscape : portrait).filter(Boolean);
    if (preferred.length) return preferred;
    if (portrait.length) return portrait;
  }

  return fallback;
}


/* Layers */
const container = document.getElementById("video-container");
const heroPosterEl = document.getElementById("hero-poster");
const videoA = document.getElementById("videoA");
const videoB = document.getElementById("videoB");

let front = videoA;
let back  = videoB;

let audioUnlocked = false;
let switching = false;
let exclusiveMediaPlayer = null;
const AUDIO_VOLUME_KEY = "va_volume";
const DEFAULT_MASTER_VOLUME = 0.7;
let masterVolume = (() => {
  const saved = parseFloat(localStorage.getItem(AUDIO_VOLUME_KEY) || "");
  if (!Number.isFinite(saved)) return DEFAULT_MASTER_VOLUME;
  return Math.min(1, Math.max(0, saved));
})();
let userMuted = masterVolume <= 0.001;

/* ================= MODE ================= */
const MODE_KEY = "va_mode";
const body = document.body;
const toggle = document.getElementById("mode-toggle");
const mobileThemeBtn = document.getElementById("mobile-theme");
const mobileVolumeWrap = document.getElementById("mobile-volume-wrap");
const mobileVolumeInput = document.getElementById("mobile-volume");
const salesSection = document.getElementById("sales");
const salesPosterEl = document.getElementById("sales-poster");
const salesBackgroundVideo = document.getElementById("bg-video");
const showcaseCarouselVideos = Array.from(document.querySelectorAll(".showcase-carousel__video"));
const showcaseWaterSection = document.querySelector("[data-water-transition]");
const showcaseAmbientVideos = Array.from(document.querySelectorAll(".showcase-video-stack__video"));
const showcaseAmbientMarkers = Array.from(document.querySelectorAll("[data-showcase-audio]"));
const showcaseAmbientEntries = (showcaseAmbientMarkers.length
  ? showcaseAmbientMarkers
  : showcaseAmbientVideos
).map((el, index) => [
  el.dataset.showcaseAudio || `showcase-${index}`,
  el
]);
const showcaseAmbientVideoMap = new Map(
  showcaseAmbientEntries.map(([name], index) => [name, showcaseAmbientVideos[index] || null])
);
const waterManagedAmbientVideos = new Set(
  showcaseAmbientVideos.filter((video) => video?.closest("[data-water-transition]"))
);
const waterManagedAmbientSections = new Set(
  showcaseAmbientEntries
    .filter(([name], index) => showcaseAmbientVideos[index]?.closest("[data-water-transition]"))
    .map(([name]) => name)
);
const ambientSections = [
  ["hero", container],
  ["sales", salesSection],
  ...showcaseAmbientEntries
].filter(([, el]) => !!el);

let activeAmbientSection = "hero";
let ambientRouteTicking = false;
let ambientRouteResumePending = false;
let heroVisible = true;
let heroCulled = false;
let mediaQuality = "high";

const POSTER_CACHE = "va-posters-v1";
const SALES_POSTER_KEY = "sales-hello-v3";
const cachedPosterKeys = new Set();
const inflightPosterKeys = new Set();
const posterCanvas = document.createElement("canvas");
const posterCtx = posterCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
const showcasePosterUrls = new Map();
const showcasePosterTargets = new Map();
const showcasePosterInflight = new Set();
const showcasePosterCacheInflight = new Set();
const managedVideoReleaseTimers = new WeakMap();
const managedVideoHydrationTokens = new WeakMap();
const managedHydrationQueue = [];
let managedHydrationActive = 0;
let managedHydrationSequence = 0;
let pageScrollSettlesAt = 0;

window.addEventListener("scroll", () => {
  pageScrollSettlesAt = performance.now() + 320;
}, { passive: true });

function getConnectionInfo(){
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

function detectMediaQuality(){
  const connection = getConnectionInfo();
  const effectiveType = String(connection?.effectiveType || "");
  const saveData = !!connection?.saveData;
  const deviceMemory = Number(navigator.deviceMemory || 0);
  const cpuCores = Number(navigator.hardwareConcurrency || 0);
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = isMobileViewport();

  if (prefersReduced || saveData) return "lite";
  if (/^(slow-)?2g$/i.test(effectiveType) || /^3g$/i.test(effectiveType)){
    return mobile ? "lite" : "balanced";
  }
  if ((deviceMemory && deviceMemory <= 4) || (cpuCores && cpuCores <= 4)){
    return mobile ? "lite" : "balanced";
  }
  if (mobile || (deviceMemory && deviceMemory <= 8)) return "balanced";
  return "high";
}

function applyMediaQuality(next = detectMediaQuality()){
  if (!body) return;
  mediaQuality = next;
  body.dataset.mediaQuality = next;
  body.classList.remove("quality-high", "quality-balanced", "quality-lite");
  body.classList.add(`quality-${next}`);
}

function getHeroPosterKey(targetMode){
  return `hero-${targetMode}`;
}

function getShowcasePosterKey(src){
  return `showcase-${src}-v2`;
}

function getPosterRequest(key){
  return new Request(new URL(`./__poster__/${encodeURIComponent(key)}.jpg`, window.location.href).toString());
}

function revokePosterObjectUrl(img){
  if (!img) return;
  const currentUrl = img.dataset.objectUrl;
  if (!currentUrl) return;
  URL.revokeObjectURL(currentUrl);
  delete img.dataset.objectUrl;
}

function setPosterBlob(img, blob, key){
  if (!img || !blob) return;
  revokePosterObjectUrl(img);
  const objectUrl = URL.createObjectURL(blob);
  img.src = objectUrl;
  img.dataset.objectUrl = objectUrl;
  if (key) img.dataset.posterKey = key;
}

async function readPosterBlob(key){
  if (!("caches" in window)) return null;

  try{
    const cache = await caches.open(POSTER_CACHE);
    const response = await cache.match(getPosterRequest(key));
    if (!response) return null;
    return await response.blob();
  }catch{
    return null;
  }
}

async function primePoster(img, key){
  if (!img || !key) return false;

  const blob = await readPosterBlob(key);
  if (!blob) return false;

  cachedPosterKeys.add(key);
  setPosterBlob(img, blob, key);
  return true;
}

async function storePosterBlob(key, blob){
  if (!key || !blob || !("caches" in window)) return;

  try{
    const cache = await caches.open(POSTER_CACHE);
    await cache.put(getPosterRequest(key), new Response(blob, {
      headers: { "Content-Type": blob.type || "image/jpeg" }
    }));
    cachedPosterKeys.add(key);
  }catch{}
}

function showPoster(img){
  if (!img) return;
  img.classList.remove("is-hidden");
}

function hidePoster(img){
  if (!img) return;
  img.classList.add("is-hidden");
}

function capturePoster(video, key, img = null){
  if (!posterCtx || !video || !key) return;
  if (cachedPosterKeys.has(key) || inflightPosterKeys.has(key)) return;
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

  inflightPosterKeys.add(key);

  try{
    const maxWidth = mediaQuality === "lite" ? 720 : 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    posterCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    posterCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    posterCtx.drawImage(video, 0, 0, posterCanvas.width, posterCanvas.height);

    if (typeof posterCanvas.toBlob !== "function"){
      inflightPosterKeys.delete(key);
      return;
    }

    posterCanvas.toBlob(async (blob) => {
      inflightPosterKeys.delete(key);
      if (!blob) return;
      await storePosterBlob(key, blob);
      if (img && img.dataset.posterKey !== key){
        setPosterBlob(img, blob, key);
      }
    }, "image/jpeg", mediaQuality === "lite" ? 0.68 : 0.78);
  }catch{
    inflightPosterKeys.delete(key);
  }
}

applyMediaQuality();
primeManagedShowcasePosters();

if ("serviceWorker" in navigator && /^https?:$/i.test(window.location.protocol)){
  window.addEventListener("load", () => {
    const register = () => navigator.serviceWorker.register("./sw.js").catch(() => {});
    if ("requestIdleCallback" in window){
      window.requestIdleCallback(register, { timeout: 2200 });
    } else {
      window.setTimeout(register, 1200);
    }
  }, { once: true });
}

function pickRandom(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

function getManagedVideoSource(video){
  if (!video) return "";
  return video.dataset.src || video.currentSrc || video.getAttribute("src") || "";
}

function isPageScrollSettling(now = performance.now()){
  return now < pageScrollSettlesAt;
}

function requestIdleWork(callback, timeout = 1800){
  if ("requestIdleCallback" in window){
    window.requestIdleCallback(callback, { timeout });
    return;
  }

  window.setTimeout(callback, Math.min(timeout, 250));
}

function getManagedHydrationLimit(){
  return mediaQuality === "high" ? 2 : 1;
}

function getManagedPriorityValue(priority){
  if (priority === "high") return 2;
  if (priority === "low") return 0;
  return 1;
}

function pumpManagedHydrationQueue(){
  const limit = getManagedHydrationLimit();

  if (managedHydrationQueue.length > 1){
    managedHydrationQueue.sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  while (managedHydrationActive < limit && managedHydrationQueue.length){
    const item = managedHydrationQueue.shift();
    managedHydrationActive += 1;

    Promise.resolve()
      .then(item.run)
      .then(item.resolve, () => item.resolve(null))
      .finally(() => {
        managedHydrationActive = Math.max(0, managedHydrationActive - 1);
        pumpManagedHydrationQueue();
      });
  }
}

function queueManagedHydration(video, priority, run){
  return new Promise((resolve) => {
    managedHydrationQueue.push({
      video,
      priority: getManagedPriorityValue(priority),
      order: ++managedHydrationSequence,
      run,
      resolve
    });
    pumpManagedHydrationQueue();
  });
}

function cancelManagedVideoRelease(video){
  const timer = managedVideoReleaseTimers.get(video);
  if (!timer) return;
  window.clearTimeout(timer);
  managedVideoReleaseTimers.delete(video);
}

function hardReleaseManagedVideo(video){
  if (!video || !video.classList.contains("showcase-managed-video--idle")) return;

  const src = getManagedVideoSource(video);
  if (src && !video.dataset.src){
    video.dataset.src = src;
  }

  if (!video.getAttribute("src")) return;

  video.removeAttribute("src");
  video.dataset.hydrated = "false";
  try { video.load(); } catch {}
}

function scheduleManagedVideoRelease(video){
  if (!video) return;
  cancelManagedVideoRelease(video);

  const delay = mediaQuality === "lite" ? 14000 : 45000;
  const timer = window.setTimeout(() => {
    managedVideoReleaseTimers.delete(video);

    requestIdleWork(() => {
      if (!video.classList.contains("showcase-managed-video--idle")) return;

      if (isPageScrollSettling()){
        scheduleManagedVideoRelease(video);
        return;
      }

      if (!document.hidden && mediaQuality !== "lite"){
        scheduleManagedVideoRelease(video);
        return;
      }

      hardReleaseManagedVideo(video);
    }, 2600);
  }, delay);

  managedVideoReleaseTimers.set(video, timer);
}

function getManagedPosterElement(video){
  return video?.parentElement?.querySelector("img") || null;
}

function showManagedPoster(video){
  const poster = getManagedPosterElement(video);
  if (!poster) return;
  const cachedUrl = showcasePosterUrls.get(getManagedVideoSource(video));
  if (cachedUrl && poster.src !== cachedUrl){
    poster.src = cachedUrl;
  }
  if (!poster.getAttribute("src") && !poster.currentSrc) return;
  showPoster(poster);
}

function hideManagedPoster(video){
  const poster = getManagedPosterElement(video);
  if (!poster) return;
  hidePoster(poster);
}

function waitForVideoReady(video, timeout = 1600){
  if (!video) return Promise.resolve(null);
  if (video.readyState >= 2) return Promise.resolve(video);

  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      cleanup();
      resolve(video);
    };
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("canplay", done);
      video.removeEventListener("error", done);
    };

    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("error", done, { once: true });
    timer = window.setTimeout(done, timeout);
  });
}

function waitForVideoMetadata(video, timeout = 1200){
  if (!video) return Promise.resolve(null);
  if (video.readyState >= 1) return Promise.resolve(video);

  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      cleanup();
      resolve(video);
    };
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", done);
    };

    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", done, { once: true });
    timer = window.setTimeout(done, timeout);
  });
}

function waitForManagedVideoFrame(video, timeout = 1600){
  if (!video) return Promise.resolve(null);

  if (typeof video.requestVideoFrameCallback === "function"){
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      let callbackId = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        resolve(video);
      };

      try{
        callbackId = video.requestVideoFrameCallback(done);
      }catch{
        callbackId = 0;
      }

      timer = window.setTimeout(() => {
        if (callbackId && typeof video.cancelVideoFrameCallback === "function"){
          try { video.cancelVideoFrameCallback(callbackId); } catch {}
        }
        done();
      }, timeout);
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      requestAnimationFrame(() => resolve(video));
    };
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("canplay", done);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", done);
    };

    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", done, { once: true });
    timer = window.setTimeout(done, timeout);
  });
}

function seekManagedVideoToFrame(video, frameTime = 0.01, timeout = 1600){
  if (!video) return Promise.resolve(null);
  if (video.readyState >= 2 && Math.abs((video.currentTime || 0) - frameTime) < 0.035){
    return waitForManagedVideoFrame(video, timeout);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(video);
    };
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", done);
    };
    const seek = () => {
      try{
        if (video.readyState >= 1 && Math.abs((video.currentTime || 0) - frameTime) >= 0.035){
          const duration = Number(video.duration || 0);
          const targetTime = duration > 0 ? Math.min(frameTime, Math.max(0, duration - 0.05)) : frameTime;
          video.currentTime = targetTime;
          return;
        }
      }catch{}

      waitForManagedVideoFrame(video, timeout).then(done);
    };

    video.addEventListener("seeked", () => {
      waitForManagedVideoFrame(video, timeout).then(done);
    }, { once: true });
    video.addEventListener("error", done, { once: true });

    if (video.readyState >= 1){
      seek();
    } else {
      video.addEventListener("loadedmetadata", seek, { once: true });
    }

    timer = window.setTimeout(done, timeout);
  });
}

function hydrateManagedVideo(video, { priority = "normal", timeout = 2200 } = {}){
  if (!video) return Promise.resolve(null);

  const src = getManagedVideoSource(video);
  if (!src) return Promise.resolve(video);

  cancelManagedVideoRelease(video);
  video.classList.remove("showcase-managed-video--idle");
  const token = {};
  managedVideoHydrationTokens.set(video, token);
  const isHighPriority = priority === "high" && mediaQuality !== "lite";
  const desiredPreload = isHighPriority ? "auto" : "metadata";
  const isAlreadyHydrated = video.dataset.hydrated === "true" && (video.getAttribute("src") || video.currentSrc);
  const shouldUpgradeLoad = isAlreadyHydrated && isHighPriority && video.dataset.hydrationPriority !== "high";

  if (video.preload !== desiredPreload){
    video.preload = desiredPreload;
  }

  video.dataset.hydrationPriority = isHighPriority ? "high" : "normal";

  const finishHydration = (readyVideo) => {
    if (managedVideoHydrationTokens.get(video) !== token) return null;
    managedVideoHydrationTokens.delete(video);

    if (readyVideo){
      captureManagedShowcasePoster(readyVideo);
      hideManagedPoster(readyVideo);
    }

    return readyVideo;
  }

  const runHydration = () => {
    if (managedVideoHydrationTokens.get(video) !== token) return Promise.resolve(null);
    if (video.classList.contains("showcase-managed-video--idle")) return Promise.resolve(null);

    if (!isAlreadyHydrated){
      video.setAttribute("src", src);
      video.dataset.hydrated = "true";

      try { video.load(); } catch {}
    } else if (shouldUpgradeLoad && video.readyState < 2){
      try { video.load(); } catch {}
    }

    return waitForVideoReady(video, timeout).then(finishHydration);
  };

  if (isAlreadyHydrated){
    return runHydration();
  }

  return queueManagedHydration(video, priority, runHydration);
}

function hydrateManagedStillFrame(video, { frameTime = 0.01, priority = "low", timeout = 2800 } = {}){
  if (!video) return Promise.resolve(null);

  const src = getManagedVideoSource(video);
  if (!src) return Promise.resolve(video);

  cancelManagedVideoRelease(video);
  video.muted = true;
  const token = {};
  managedVideoHydrationTokens.set(video, token);

  if (video.preload !== "auto"){
    video.preload = "auto";
  }
  video.dataset.hydrationPriority = "still";

  const isAlreadyHydrated = video.dataset.hydrated === "true" && (video.getAttribute("src") || video.currentSrc);

  const finishHydration = (readyVideo) => {
    if (managedVideoHydrationTokens.get(video) !== token) return null;
    managedVideoHydrationTokens.delete(video);

    if (readyVideo){
      pauseVideo(readyVideo);
      if (readyVideo.readyState >= 2){
        readyVideo.classList.remove("showcase-managed-video--idle");
        captureManagedShowcasePoster(readyVideo);
      }
    }

    return readyVideo;
  };

  const runHydration = () => {
    if (managedVideoHydrationTokens.get(video) !== token) return Promise.resolve(null);

    if (!isAlreadyHydrated){
      video.setAttribute("src", src);
      video.dataset.hydrated = "true";

      try { video.load(); } catch {}
    }

    return waitForVideoMetadata(video, Math.min(timeout, 1400))
      .then((metadataVideo) => {
        if (managedVideoHydrationTokens.get(video) !== token) return null;
        pauseVideo(metadataVideo);
        return seekManagedVideoToFrame(metadataVideo, frameTime, Math.max(900, timeout - 1200));
      })
      .then(finishHydration);
  };

  if (isAlreadyHydrated){
    return runHydration();
  }

  return queueManagedHydration(video, priority, runHydration);
}

function releaseManagedVideo(video){
  if (!video) return;

  managedVideoHydrationTokens.delete(video);
  pauseVideo(video);
  video.classList.add("showcase-managed-video--idle");
  showManagedPoster(video);

  const src = getManagedVideoSource(video);
  if (src && !video.dataset.src){
    video.dataset.src = src;
  }

  scheduleManagedVideoRelease(video);
}

function showManagedPosterFrame(video){
  const poster = getManagedPosterElement(video);
  if (!poster) return false;

  showManagedPoster(video);
  if (!poster.getAttribute("src") && !poster.currentSrc) return false;
  if (!poster.complete || !poster.naturalWidth) return false;

  managedVideoHydrationTokens.delete(video);
  pauseVideo(video);
  video.classList.add("showcase-managed-video--idle");

  const src = getManagedVideoSource(video);
  if (src && !video.dataset.src){
    video.dataset.src = src;
  }

  scheduleManagedStillVideoRelease(video);
  return true;
}

function scheduleManagedStillVideoRelease(video){
  if (!video) return;

  cancelManagedVideoRelease(video);
  const delay = mediaQuality === "lite" ? 1200 : 2600;
  const timer = window.setTimeout(() => {
    managedVideoReleaseTimers.delete(video);

    requestIdleWork(() => {
      if (!video.classList.contains("showcase-managed-video--idle")) return;

      const poster = getManagedPosterElement(video);
      if (!poster || poster.classList.contains("is-hidden") || !poster.complete || !poster.naturalWidth){
        scheduleManagedVideoRelease(video);
        return;
      }

      hardReleaseManagedVideo(video);
    }, 900);
  }, delay);

  managedVideoReleaseTimers.set(video, timer);
}

function freezeManagedVideoAtStart(video, frameTime = 0.01){
  if (!video) return;

  video.classList.remove("showcase-managed-video--idle");
  video.muted = true;
  pauseVideo(video);

  const seekToStart = () => {
    try{
      if (Math.abs((video.currentTime || 0) - frameTime) < 0.02){
        return;
      }

      video.currentTime = frameTime;
    }catch{}
  };

  if (video.readyState >= 2){
    seekToStart();
    return;
  }

  video.addEventListener("loadeddata", seekToStart, { once: true });
}

function registerShowcasePosterTarget(src, img){
  if (!src || !img) return;

  if (!showcasePosterTargets.has(src)){
    showcasePosterTargets.set(src, new Set());
  }

  showcasePosterTargets.get(src).add(img);

  const staticPoster = img.getAttribute("src") || img.currentSrc;
  if (staticPoster && !showcasePosterUrls.has(src)){
    showcasePosterUrls.set(src, new URL(staticPoster, window.location.href).toString());
  }

  const cachedUrl = showcasePosterUrls.get(src);
  if (cachedUrl){
    img.src = cachedUrl;
    return;
  }

  primeShowcasePoster(src).catch(() => {});
}

function applyShowcasePoster(src, posterUrl){
  if (!src || !posterUrl) return;

  showcasePosterUrls.set(src, posterUrl);
  const targets = showcasePosterTargets.get(src);
  if (!targets) return;

  targets.forEach((img) => {
    img.src = posterUrl;
  });
}

async function primeShowcasePoster(src){
  if (!src || showcasePosterUrls.has(src) || showcasePosterCacheInflight.has(src)) return false;

  showcasePosterCacheInflight.add(src);

  try{
    const blob = await readPosterBlob(getShowcasePosterKey(src));
    if (!blob) return false;

    applyShowcasePoster(src, URL.createObjectURL(blob));
    return true;
  }catch{
    return false;
  }finally{
    showcasePosterCacheInflight.delete(src);
  }
}

function hasShowcasePosterForVideo(video){
  return showcasePosterUrls.has(getManagedVideoSource(video));
}

function isUsableShowcasePosterFrame(){
  try{
    const width = posterCanvas.width;
    const height = posterCanvas.height;
    if (!width || !height) return false;

    const data = posterCtx.getImageData(0, 0, width, height).data;
    const stepX = Math.max(1, Math.floor(width / 28));
    const stepY = Math.max(1, Math.floor(height / 18));
    let samples = 0;
    let total = 0;
    let max = 0;
    let bright = 0;

    for (let y = 0; y < height; y += stepY){
      for (let x = 0; x < width; x += stepX){
        const i = ((y * width) + x) * 4;
        const luma = (data[i] * 0.2126) + (data[i + 1] * 0.7152) + (data[i + 2] * 0.0722);
        samples += 1;
        total += luma;
        max = Math.max(max, luma);
        if (luma > 28) bright += 1;
      }
    }

    const average = samples ? total / samples : 0;
    return max > 24 && (average > 7 || bright >= 4);
  }catch{
    return true;
  }
}

function captureManagedShowcasePoster(video){
  if (!posterCtx || !video) return "";

  const src = getManagedVideoSource(video);
  if (!src || showcasePosterUrls.has(src)) return showcasePosterUrls.get(src) || "";
  if (showcasePosterInflight.has(src)) return "";
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return "";

  try{
    showcasePosterInflight.add(src);
    const maxWidth = mediaQuality === "lite" ? 720 : 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    posterCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    posterCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    posterCtx.drawImage(video, 0, 0, posterCanvas.width, posterCanvas.height);
    if (!isUsableShowcasePosterFrame()){
      showcasePosterInflight.delete(src);
      return "";
    }

    const finish = (blob) => {
      showcasePosterInflight.delete(src);
      if (!blob) return;
      storePosterBlob(getShowcasePosterKey(src), blob).catch(() => {});
      applyShowcasePoster(src, URL.createObjectURL(blob));
    };

    if (typeof posterCanvas.toBlob === "function"){
      posterCanvas.toBlob(finish, "image/jpeg", mediaQuality === "lite" ? 0.68 : 0.78);
      return "";
    }

    const posterUrl = posterCanvas.toDataURL("image/jpeg", mediaQuality === "lite" ? 0.68 : 0.78);
    showcasePosterInflight.delete(src);
    if (!posterUrl) return "";
    applyShowcasePoster(src, posterUrl);
    return posterUrl;
  }catch{
    showcasePosterInflight.delete(src);
    return "";
  }
}

function primeManagedShowcasePosters(){
  [...showcaseCarouselVideos, ...showcaseAmbientVideos].forEach((video) => {
    const src = getManagedVideoSource(video);
    const poster = video.parentElement?.querySelector("img");
    registerShowcasePosterTarget(src, poster);
  });
}

function hydrateDeferredVideo(video){
  if (!video) return Promise.resolve(null);
  if (video.dataset.hydrated === "true") return Promise.resolve(video);

  let assigned = false;

  if (video.dataset.src && !video.getAttribute("src")){
    video.setAttribute("src", video.dataset.src);
    assigned = true;
  }

  video.querySelectorAll("source[data-src]").forEach((source) => {
    if (source.getAttribute("src")) return;
    source.setAttribute("src", source.dataset.src);
    assigned = true;
  });

  video.dataset.hydrated = "true";

  if (assigned){
    try { video.load(); } catch {}
  }

  return new Promise((resolve) => {
    if (!assigned || video.readyState >= 2){
      resolve(video);
      return;
    }

    let timer = 0;
    const done = () => {
      cleanup();
      resolve(video);
    };
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("canplay", done);
      video.removeEventListener("error", done);
    };

    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("error", done, { once: true });
    timer = window.setTimeout(done, 1800);
  });
}

function getShowcaseAmbientVideo(sectionName = activeAmbientSection){
  if (waterManagedAmbientSections.has(sectionName)) return null;
  return showcaseAmbientVideoMap.get(sectionName) || null;
}

function getCurrentAmbientVideo(){
  if (waterManagedAmbientSections.has(activeAmbientSection)) return null;

  const showcaseVideo = getShowcaseAmbientVideo();
  if (showcaseVideo) return showcaseVideo;

  switch (activeAmbientSection){
    case "sales":
      return salesBackgroundVideo;
    default:
      return front;
  }
}

function setVideoAudioState(video, audible){
  if (!video) return;
  const shouldUnmute = audible && audioUnlocked && !userMuted;
  video.volume = audible ? masterVolume : 0;
  video.muted = !shouldUnmute;
}

function resolveAmbientSection(){
  const viewportCenter = window.innerHeight * 0.5;
  let choice = ambientSections[0]?.[0] || "hero";
  let bestDistance = Number.POSITIVE_INFINITY;

  ambientSections.forEach(([name, el]) => {
    const rect = el.getBoundingClientRect();
    const center = rect.top + (rect.height * 0.5);

    if (rect.top <= viewportCenter && rect.bottom >= viewportCenter){
      choice = name;
      bestDistance = -1;
      return;
    }

    if (bestDistance === -1) return;

    const distance = Math.abs(center - viewportCenter);
    if (distance < bestDistance){
      bestDistance = distance;
      choice = name;
    }
  });

  return choice;
}

function resumeActiveAmbientPlayback(){
  if (exclusiveMediaPlayer) return;
  const activeVideo = getCurrentAmbientVideo();
  if (!activeVideo) return;

  hydrateDeferredVideo(activeVideo).then((video) => {
    if (!video) return;

    if (audioUnlocked && !userMuted){
      tryUnmuteAndPlay(video);
      return;
    }

    tryPlayMuted(video);
  });
}

function scheduleAmbientRouting(resume = false){
  ambientRouteResumePending = ambientRouteResumePending || resume;
  if (ambientRouteTicking) return;

  ambientRouteTicking = true;
  requestAnimationFrame(() => {
    ambientRouteTicking = false;

    const previousSection = activeAmbientSection;
    const nextSection = resolveAmbientSection();
    const sectionChanged = nextSection !== previousSection;
    activeAmbientSection = nextSection;

    enforceAudioRouting();
    syncHeroCulling(ambientRouteResumePending && heroVisible);

    if (ambientRouteResumePending || sectionChanged){
      resumeActiveAmbientPlayback();
    }

    ambientRouteResumePending = false;
  });
}

function applyModeClasses(mode){
  body.classList.toggle("mode-day", mode === "day");
  body.classList.toggle("mode-night", mode !== "day");
  toggle.setAttribute("aria-pressed", String(mode === "day"));
  if (mobileThemeBtn) mobileThemeBtn.setAttribute("aria-pressed", String(mode === "day"));
}

/* Ready */
let readyTimer = null;
function forceReadySoon(){
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => container.classList.add("ready"), 180);
}
function markReady(){
  container.classList.add("ready");
  front.classList.add("drift");
  queueSlideDistanceUpdate();
  queueCinePositionUpdate();
}

/* Ensure ONLY the active layer can ever output sound */
function enforceAudioRouting(){
  if (exclusiveMediaPlayer){
    [front, back, salesBackgroundVideo, ...showcaseAmbientVideos].forEach((video) => {
      if (!video) return;
      video.volume = 0;
      video.muted = true;
      pauseVideo(video);
    });

    const shouldUnmute = audioUnlocked && !userMuted;
    exclusiveMediaPlayer.volume = shouldUnmute ? masterVolume : 0;
    exclusiveMediaPlayer.muted = !shouldUnmute;
    return;
  }

  const heroIsActive = activeAmbientSection === "hero";
  const salesIsActive = activeAmbientSection === "sales";
  const activeShowcaseVideo = getShowcaseAmbientVideo();

  setVideoAudioState(front, heroIsActive);
  back.volume = 0;
  back.muted = true;
  try { back.pause(); } catch {}
  back.currentTime = 0;

  setVideoAudioState(salesBackgroundVideo, salesIsActive);

  showcaseAmbientVideos.forEach((video) => {
    if (waterManagedAmbientVideos.has(video)) return;
    const isActive = video === activeShowcaseVideo;
    setVideoAudioState(video, isActive);
  });
}

function shouldKickMobilePlayback() {
  return isMobileViewport();
}

async function tryPlayMuted(video) {
  if (exclusiveMediaPlayer && video !== exclusiveMediaPlayer) return;
  try {
    video.muted = true;
    await video.play().catch(() => {});
  } catch {}
}

async function tryUnmuteAndPlay(video) {
  if (exclusiveMediaPlayer && video !== exclusiveMediaPlayer) return;
  try { await video.play().catch(() => {}); } catch {}
}

function pauseVideo(video){
  if (!video) return;
  try { video.pause(); } catch {}
}

function setHeroCulled(next){
  if (heroCulled === next) return;
  heroCulled = next;
  container?.classList.toggle("is-culled", next);
}

function syncHeroCulling(resume = false){
  const shouldCull = document.hidden || !heroVisible;
  setHeroCulled(shouldCull);

  if (shouldCull){
    pauseVideo(front);
    pauseVideo(back);
    return;
  }

  if (!resume) return;

  ensureHeroPlayback();
}

function shouldSkipHeroPlayback(video){
  if (!video || !video.isConnected) return true;
  return !video.currentSrc && !video.getAttribute("src");
}

function ensureHeroPlayback(){
  if (!front || document.hidden || !heroVisible || heroCulled) return;

  if (front.readyState < 2){
    front.addEventListener("canplay", () => {
      if (!front || document.hidden || !heroVisible || heroCulled) return;
      ensureHeroPlayback();
    }, { once: true });
    try { front.load(); } catch {}
    return;
  }

  if (audioUnlocked && !userMuted && activeAmbientSection === "hero"){
    tryUnmuteAndPlay(front);
    return;
  }

  tryPlayMuted(front);
}

function scheduleSoftReloadIfPaused() {
  setTimeout(async () => {
    if (!isMobileViewport()) return;
    if (heroCulled || document.hidden || !heroVisible) return;
    if (!front || !front.paused) return;
    try { await crossfadeToMode(mode).catch(() => {}); } catch {}
  }, 180);
}

async function kickMobileVideoPlayback(){
  // On some mobile browsers, unmuting doesn't resume playback unless we "re-play" similarly to a mode switch.
  if (!shouldKickMobilePlayback()) return;

  const v = front;
  const shouldUnmute = audioUnlocked && !userMuted;

  try {
    v.muted = true;
    await v.play().catch(() => {});
  } catch {}

  enforceAudioRouting();

  if (shouldUnmute){
    await tryUnmuteAndPlay(v);
  }

  scheduleSoftReloadIfPaused();
}


/* Load helper */
function loadVideoInto(el, src){
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const ok = () => finish(true);
    const err = () => finish(false);
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      el.removeEventListener("loadeddata", ok);
      el.removeEventListener("canplay", ok);
      el.removeEventListener("error", err);
    };
    el.addEventListener("loadeddata", ok, { once:true });
    el.addEventListener("canplay", ok, { once:true });
    el.addEventListener("error", err, { once:true });

    el.preload = mediaQuality === "lite" ? "metadata" : "auto";
    el.src = src;
    el.load();

    timer = window.setTimeout(() => finish(el.readyState >= 2), 1200);
  });
}

/* Crossfade: keep back MUTED always, and pause/reset old front after fade */
async function crossfadeToMode(mode){
  forceReadySoon();
  const heroCanRenderNow = !document.hidden && heroVisible;
  const heroPosterKey = getHeroPosterKey(mode);

  const list = getVideoList(mode);
  const src = pickRandom(list);
  showPoster(heroPosterEl);
  primePoster(heroPosterEl, heroPosterKey).catch(() => {});

  // prepare back
  back.classList.remove("drift","audio-fade","active");
  back.loop = true;
  back.playsInline = true;

  // IMPORTANT: back stays muted (prevents dual-audio)
  back.muted = true;
  back.volume = 0;

  const ok = await loadVideoInto(back, src);

  // Start back playback silently for a clean visual crossfade
  if (heroCanRenderNow){
    try { back.play().catch(() => {}); } catch {}
  }

  // Fade visuals
  back.classList.add("active");
  front.classList.remove("active");

  // After fade, stop the old layer completely (no hidden audio / perf)
  const oldFront = front;
  const newFront = back;

  // swap pointers immediately so routing uses the correct element
  front = newFront;
  back = oldFront;

  // drift on new front
  front.classList.add("drift");

  const warmHeroPoster = () => {
    hidePoster(heroPosterEl);
    capturePoster(front, heroPosterKey, heroPosterEl);
  };

  if (front.readyState >= 2){
    warmHeroPoster();
  } else {
    front.addEventListener("loadeddata", warmHeroPoster, { once: true });
    front.addEventListener("playing", warmHeroPoster, { once: true });
  }

  // Wait for the opacity transition to finish before pausing old
  setTimeout(() => {
    try { back.pause(); } catch {}
    back.currentTime = 0;
    back.muted = true;
    back.classList.remove("drift","audio-fade","active");
    enforceAudioRouting(); // now unmute ONLY the new front if audio is unlocked
    syncHeroCulling(heroCanRenderNow);
  }, 980);

  if (!ok) container.classList.add("ready");
  else markReady();
  syncHeroCulling(heroCanRenderNow);
}

/* ================= MENU COLLAPSE ================= */
const wrapper = document.getElementById("menu-wrapper");
const menuPanel = document.getElementById("menu");
const btn = document.getElementById("menu-btn");
const menuFireCanvas = document.getElementById("menu-fire-canvas");

function updateSlideDistance(){
  const wrapW = wrapper.getBoundingClientRect().width;
  const btnW  = btn.getBoundingClientRect().width;
  const slide = Math.max(0, wrapW - btnW + 18);
  wrapper.style.setProperty("--slide-x", slide + "px");

  // Reserve exact button width so the menu panel never sits underneath it
  wrapper.style.setProperty("--btn-px", btnW + "px");
}

let slideDistanceRaf = 0;
function queueSlideDistanceUpdate(){
  if (slideDistanceRaf) return;
  slideDistanceRaf = requestAnimationFrame(() => {
    slideDistanceRaf = 0;
    updateSlideDistance();
  });
}

queueSlideDistanceUpdate();
window.addEventListener("resize", queueSlideDistanceUpdate);

const MENU_COLLAPSED_KEY = "va_menu_collapsed";
const MENU_COLLAPSE_TRANSITION_MS = 360;
let menuCollapseMotionUntil = 0;
let menuCollapseMotionTimer = 0;

function getSavedMenuCollapsed(){
  return localStorage.getItem(MENU_COLLAPSED_KEY) === "1";
}

function rememberMenuCollapsed(nextCollapsed){
  localStorage.setItem(MENU_COLLAPSED_KEY, nextCollapsed ? "1" : "0");
}

function applyInitialMenuState(){
  const nextCollapsed = getSavedMenuCollapsed();
  wrapper.classList.toggle("collapsed", nextCollapsed);
  btn.setAttribute("aria-expanded", String(!nextCollapsed));
}

function isMenuCollapseMotionActive(now = performance.now()){
  return now < menuCollapseMotionUntil;
}

function finishMenuCollapseMotion(){
  menuCollapseMotionUntil = 0;
  if (menuCollapseMotionTimer){
    window.clearTimeout(menuCollapseMotionTimer);
    menuCollapseMotionTimer = 0;
  }
  window.dispatchEvent(new CustomEvent("va:menu-collapse-settled"));
}

function markMenuCollapseMotion(){
  const settleAt = performance.now() + MENU_COLLAPSE_TRANSITION_MS;
  menuCollapseMotionUntil = settleAt;

  if (menuCollapseMotionTimer) window.clearTimeout(menuCollapseMotionTimer);
  menuCollapseMotionTimer = window.setTimeout(() => {
    if (performance.now() + 8 < settleAt) return;
    finishMenuCollapseMotion();
  }, MENU_COLLAPSE_TRANSITION_MS + 40);

  window.dispatchEvent(new CustomEvent("va:menu-collapse-started"));
}

function setMenuCollapsed(nextCollapsed, { syncTitle = true, remember = false } = {}){
  const isCollapsed = wrapper.classList.contains("collapsed");
  btn.setAttribute("aria-expanded", String(!nextCollapsed));
  if (remember) rememberMenuCollapsed(nextCollapsed);
  if (isCollapsed === nextCollapsed) return false;

  wrapper.classList.toggle("collapsed", nextCollapsed);
  markMenuCollapseMotion();

  if (syncTitle && audioUnlocked){
    if (nextCollapsed) playTitleOut();
    else playTitleIn();
  }

  queueCinePositionUpdate();
  return true;
}

wrapper.addEventListener("transitionend", (event) => {
  if (event.target !== wrapper || event.propertyName !== "transform") return;
  finishMenuCollapseMotion();
});

applyInitialMenuState();

/* ================= MENU FIRE RIM ================= */
(() => {
  if (!menuFireCanvas || !menuPanel || !wrapper || !btn) return;

  const ctx = menuFireCanvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  const canvasRect = { left: 0, top: 0 };
  let canvasW = 1;
  let canvasH = 1;
  let dpr = 1;
  let rafId = 0;
  let menuEffectFrameTimer = 0;
  let lastEmberNow = 0;
  let lastFlameNow = 0;
  let embers = [];
  let flamelets = [];
  let flameLightBursts = [];
  let fireZoneActive = false;
  let waterZoneActive = false;
  let fireZoneRaf = 0;
  let fireIgnitionStartedAt = 0;
  let fireIgnitionProgress = 0;
  let quenchFireIgnitionProgress = 1;
  let lastFireActiveAt = 0;
  let lastFireCollapsedState = false;
  let waterStartedAt = 0;
  let waterQuenchStartedAt = 0;
  let waterQuenchHasFire = false;
  let lastWaterNow = 0;
  let waterBubbles = [];
  let splashDrops = [];
  let vaporPuffs = [];
  let quenchPlumes = [];
  let quenchClassActive = false;
  let canvasZoneClassActive = false;
  let fireZoneClassActive = false;
  let waterZoneClassActive = false;
  let cachedShape = null;
  let shapeDirty = true;
  let shapeDynamicUntil = 0;
  let lastEffectClearRect = null;
  let menuDisplayVisible = true;
  let lastMenuEffectFrameAt = 0;
  let forceFullEffectClearUntil = 0;

  const FIRE_IGNITION_MS = 2600;
  const WATER_WAKE_MS = 1700;
  const WATER_QUENCH_MS = 7600;

  function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
  }

  function smoothstep(value){
    const t = clamp(value, 0, 1);
    return t * t * (3 - (2 * t));
  }

  function segmentAmount(progress, start, end){
    return smoothstep((progress - start) / Math.max(0.001, end - start));
  }

  function lerp(a, b, t){
    return a + ((b - a) * t);
  }

  function ignitionGate(edgeProgress, softness = 0.14){
    return smoothstep((fireIgnitionProgress - edgeProgress + softness) / softness);
  }

  function fireUsesCollapsedHandle(){
    return wrapper.classList.contains("collapsed") && !isMenuCollapseMotionActive();
  }

  function hasActiveMenuEffect(){
    return fireZoneActive || waterZoneActive;
  }

  function hasActiveMenuCanvasEffect(now = performance.now()){
    return fireZoneActive || waterZoneActive;
  }

  function menuEffectCanvasDpr(){
    return Math.min(2, window.devicePixelRatio || 1);
  }

  function menuEffectFrameInterval(now){
    if (waterZoneActive) return 0;
    return 33;
  }

  function getMenuEffectFrameDelay(now){
    const interval = menuEffectFrameInterval(now);
    if (!lastMenuEffectFrameAt || interval <= 0) return 0;
    return Math.max(0, interval - (now - lastMenuEffectFrameAt));
  }

  function markMenuEffectFrame(now){
    lastMenuEffectFrameAt = now;
  }

  function queueMenuEffectFrame(delay = 0){
    if (rafId || menuEffectFrameTimer) return;

    const requestFrame = () => {
      menuEffectFrameTimer = 0;
      if (!rafId) rafId = requestAnimationFrame(draw);
    };

    if (delay > 0){
      menuEffectFrameTimer = window.setTimeout(requestFrame, delay);
      return;
    }

    rafId = requestAnimationFrame(draw);
  }

  function menuEffectCanRender(now = performance.now()){
    return true;
  }

  function setCanvasZoneClass(active){
    if (canvasZoneClassActive === active) return;
    canvasZoneClassActive = active;
    menuFireCanvas.classList.toggle("is-zone-active", active);
  }

  function setFireZoneClass(active){
    if (fireZoneClassActive === active) return;
    fireZoneClassActive = active;
    body.classList.toggle("menu-fire-zone", active);
  }

  function setWaterZoneClass(active){
    if (waterZoneClassActive === active) return;
    waterZoneClassActive = active;
    body.classList.toggle("menu-water-zone", active);
  }

  function markShapeDirty(dynamicMs = 0){
    shapeDirty = true;
    if (dynamicMs > 0){
      shapeDynamicUntil = Math.max(shapeDynamicUntil, performance.now() + dynamicMs);
    }
  }

  function refreshShape(){
    cachedShape = readShape();
    shapeDirty = false;
    return cachedShape;
  }

  function getShape(now = performance.now()){
    if (!cachedShape || shapeDirty || now < shapeDynamicUntil){
      return refreshShape();
    }
    return cachedShape;
  }

  function getCachedEffectPath(shape, key, build){
    if (!shape._pathCache) shape._pathCache = Object.create(null);
    if (!shape._pathCache[key]){
      const path = new Path2D();
      build(path);
      shape._pathCache[key] = path;
    }
    return shape._pathCache[key];
  }

  function resetFireForCurrentShape(scatter = false, { preserveIgnition = false } = {}){
    const previousIgnitionStartedAt = fireIgnitionStartedAt;
    const previousIgnitionProgress = fireIgnitionProgress;

    if (!preserveIgnition){
      fireIgnitionStartedAt = 0;
      fireIgnitionProgress = 0;
    }

    flameLightBursts = [];
    flamelets.forEach((flamelet) => resetFlamelet(flamelet, scatter));
    const shape = refreshShape();
    embers.forEach((ember) => resetEmber(ember, shape, scatter));

    if (preserveIgnition){
      fireIgnitionStartedAt = previousIgnitionStartedAt;
      fireIgnitionProgress = previousIgnitionProgress;
    }
  }

  function resetWaterForCurrentShape(scatter = false){
    lastWaterNow = 0;
    const shape = refreshShape();
    waterBubbles.forEach((bubble) => resetWaterBubble(bubble, shape, scatter));
    splashDrops.forEach((drop) => resetSplashDrop(drop, shape, scatter));
    vaporPuffs.forEach((puff) => resetVaporPuff(puff, shape, scatter));
    quenchPlumes.forEach((plume) => resetQuenchPlume(plume, shape, scatter));
  }

  function edgeIgnitionProgress(edge, t){
    if (fireUsesCollapsedHandle()){
      if (edge === "button") return 0.06 + (0.70 * (1 - t));
      return 1.2;
    }

    if (edge === "bottom") return 0.08 + (0.08 * t);
    if (edge === "left") return 0.10 + (0.08 * (1 - t));
    if (edge === "top") return 0.13 + (0.08 * t);
    if (edge === "button") return 0.16 + (0.08 * (1 - t));
    return 0.82;
  }

  function updateIgnition(now){
    if (!fireZoneActive){
      fireIgnitionStartedAt = 0;
      fireIgnitionProgress = 0;
      return;
    }

    if (!fireIgnitionStartedAt) fireIgnitionStartedAt = now;
    const duration = fireUsesCollapsedHandle() ? FIRE_IGNITION_MS : 1400;
    fireIgnitionProgress = Math.max(
      fireIgnitionProgress,
      smoothstep((now - fireIgnitionStartedAt) / duration)
    );
  }

  function waterProgress(now){
    if (!waterZoneActive || !waterStartedAt) return 0;
    return smoothstep((now - waterStartedAt) / WATER_WAKE_MS);
  }

  function quenchProgress(now){
    if (!waterZoneActive || !waterQuenchStartedAt) return 1;
    return smoothstep((now - waterQuenchStartedAt) / WATER_QUENCH_MS);
  }

  function resizeCanvas(){
    const rect = menuFireCanvas.getBoundingClientRect();
    canvasRect.left = rect.left;
    canvasRect.top = rect.top;
    menuDisplayVisible = getComputedStyle(wrapper).display !== "none";
    const nextCanvasW = Math.max(1, Math.round(rect.width));
    const nextCanvasH = Math.max(1, Math.round(rect.height));
    const nextDpr = menuEffectCanvasDpr();

    if (
      nextCanvasW === canvasW &&
      nextCanvasH === canvasH &&
      nextDpr === dpr &&
      menuFireCanvas.width === Math.round(nextCanvasW * nextDpr) &&
      menuFireCanvas.height === Math.round(nextCanvasH * nextDpr)
    ){
      markShapeDirty(260);
      return;
    }

    canvasW = nextCanvasW;
    canvasH = nextCanvasH;
    dpr = nextDpr;

    menuFireCanvas.width = Math.round(canvasW * dpr);
    menuFireCanvas.height = Math.round(canvasH * dpr);
    menuFireCanvas.style.width = `${canvasW}px`;
    menuFireCanvas.style.height = `${canvasH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastEffectClearRect = null;
    markShapeDirty(260);
    rebuildFlamelets();
    rebuildEmbers();
    rebuildWaterEffects();
  }

  function relativeRect(el){
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left - canvasRect.left,
      y: rect.top - canvasRect.top,
      w: rect.width,
      h: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    };
  }

  function readShape(){
    const canvasBounds = menuFireCanvas.getBoundingClientRect();
    canvasRect.left = canvasBounds.left;
    canvasRect.top = canvasBounds.top;

    if (waterZoneActive){
      const rect = btn.getBoundingClientRect();
      const buttonShape = {
        x: rect.left - canvasRect.left,
        y: rect.top - canvasRect.top,
        w: rect.width,
        h: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };

      if (!fireUsesCollapsedHandle()){
        return {
          menu: relativeRect(menuPanel),
          button: buttonShape
        };
      }

      return {
        menu: buttonShape,
        button: buttonShape
      };
    }

    return {
      menu: relativeRect(menuPanel),
      button: relativeRect(btn)
    };
  }

  function setQuenchClass(active, fireStyled = fireZoneActive){
    if (quenchClassActive !== active){
      quenchClassActive = active;
      body.classList.toggle("menu-quenching-zone", active);
    }
    setFireZoneClass(fireStyled);
  }

  function syncMenuEffectBodyClasses(now = performance.now()){
    const quench = waterZoneActive ? quenchProgress(now) : 1;
    const quenching = waterZoneActive && quench >= 0.50 && quench < 0.985;
    const fireStyled = fireZoneActive || (waterZoneActive && waterQuenchHasFire && quench < 0.86);
    const waterStyled = waterZoneActive && quench >= 0.78;

    setWaterZoneClass(waterStyled);
    setQuenchClass(quenching, fireStyled);
  }

  function syncMenuEffectClasses(now = performance.now()){
    const active = hasActiveMenuCanvasEffect(now) && menuEffectCanRender(now);
    setCanvasZoneClass(active);
    syncMenuEffectBodyClasses(now);
  }

  function setMenuEffectZones(nextFireActive, nextWaterActive){
    const waterActive = !!nextWaterActive;
    const fireActive = !!nextFireActive && !waterActive;
    const now = performance.now();

    if (fireZoneActive === fireActive && waterZoneActive === waterActive){
      if (hasActiveMenuEffect() && !rafId) start();
      return;
    }

    const fireChanged = fireZoneActive !== fireActive;
    const waterChanged = waterZoneActive !== waterActive;
    if (fireChanged && fireZoneActive && !fireActive) lastFireActiveAt = now;
    const shouldQuenchFire = waterActive;
    const quenchStartProgress = shouldQuenchFire ? Math.max(fireIgnitionProgress, 0.94) : 0;

    flameLightBursts = [];

    if (fireChanged){
      fireIgnitionStartedAt = 0;
      fireIgnitionProgress = 0;
      if (fireActive){
        resetFireForCurrentShape(false);
      }
    }

    fireZoneActive = fireActive;
    waterZoneActive = waterActive;
    if (fireActive) lastFireActiveAt = now;

    if (waterChanged){
      waterStartedAt = waterActive ? now : 0;
      waterQuenchStartedAt = waterStartedAt;
      waterQuenchHasFire = shouldQuenchFire;
      quenchFireIgnitionProgress = waterActive ? quenchStartProgress : 1;
      markShapeDirty(420);
      if (waterActive){
        resetWaterForCurrentShape(false);
      }
    }

    syncMenuEffectClasses();

    if (fireActive || waterActive){
      start();
    } else {
      fireIgnitionStartedAt = 0;
      fireIgnitionProgress = 0;
      waterQuenchStartedAt = 0;
      waterQuenchHasFire = false;
      quenchFireIgnitionProgress = 1;
      setQuenchClass(false, false);
      stop();
      clearEffectCanvas();
    }
  }

  function syncFireZone(){
    fireZoneRaf = 0;

    if (!salesSection || isMobileViewport()){
      setMenuEffectZones(false, false);
      return;
    }

    const now = performance.now();
    const rect = salesSection.getBoundingClientRect();
    const salesFireActive = rect.top < window.innerHeight * 0.76 && rect.bottom > window.innerHeight * 0.20;
    let waterActive = false;
    let bridgeFireToWater = false;

    if (showcaseWaterSection){
      const waterRect = showcaseWaterSection.getBoundingClientRect();
      waterActive = waterRect.top < window.innerHeight * 0.42 && waterRect.bottom > window.innerHeight * 0.18;
      bridgeFireToWater = !waterActive
        && waterRect.top < window.innerHeight * 0.88
        && waterRect.bottom > window.innerHeight * 0.18
        && (fireZoneActive || salesFireActive || (now - lastFireActiveAt) < 1800 || rect.bottom > -window.innerHeight * 0.35);
    }

    const fireActive = !waterActive && (salesFireActive || bridgeFireToWater);
    setMenuEffectZones(fireActive, waterActive);
  }

  function queueFireZone(){
    if (!fireZoneRaf) fireZoneRaf = requestAnimationFrame(syncFireZone);
  }

  function isRenderable(shape){
    if (!hasActiveMenuEffect() || document.hidden || isMobileViewport()) return false;
    if (!menuDisplayVisible) return false;
    return (
      shape.menu.h > 10 &&
      shape.button.h > 10 &&
      shape.button.right > -80 &&
      shape.menu.left < window.innerWidth + 80 &&
      shape.menu.bottom > -80 &&
      shape.menu.top < window.innerHeight + 80
    );
  }

  function tracePanelPath(target, rect, radius, inflate = 0){
    const x = rect.x - inflate;
    const y = rect.y - inflate;
    const w = rect.w + (inflate * 2);
    const h = rect.h + (inflate * 2);
    const r = clamp(radius + inflate, 0, Math.min(w, h) / 2);

    target.moveTo(x + r, y);
    target.lineTo(x + w + 8, y);
    target.lineTo(x + w + 8, y + h);
    target.lineTo(x + r, y + h);
    target.quadraticCurveTo(x, y + h, x, y + h - r);
    target.lineTo(x, y + r);
    target.quadraticCurveTo(x, y, x + r, y);
  }

  function getEffectClearRect(shape){
    const padX = waterZoneActive ? 380 : 320;
    const padY = waterZoneActive ? 280 : 240;
    const left = Math.floor(Math.min(shape.menu.x, shape.button.x) - padX);
    const top = Math.floor(Math.min(shape.menu.y, shape.button.y) - padY);
    const right = Math.ceil(Math.max(shape.menu.x + shape.menu.w, shape.button.x + shape.button.w) + padX);
    const bottom = Math.ceil(Math.max(shape.menu.y + shape.menu.h, shape.button.y + shape.button.h) + padY);

    return {
      x: clamp(left, 0, canvasW),
      y: clamp(top, 0, canvasH),
      w: clamp(right, 0, canvasW) - clamp(left, 0, canvasW),
      h: clamp(bottom, 0, canvasH) - clamp(top, 0, canvasH)
    };
  }

  function clearEffectCanvas(shape = null){
    if (!shape){
      ctx.clearRect(0, 0, canvasW, canvasH);
      lastEffectClearRect = null;
      return;
    }

    const next = getEffectClearRect(shape);
    const previous = lastEffectClearRect;
    if (!previous){
      ctx.clearRect(next.x, next.y, next.w, next.h);
      lastEffectClearRect = next;
      return;
    }

    const x1 = Math.min(previous.x, next.x);
    const y1 = Math.min(previous.y, next.y);
    const x2 = Math.max(previous.x + previous.w, next.x + next.w);
    const y2 = Math.max(previous.y + previous.h, next.y + next.h);
    ctx.clearRect(x1, y1, x2 - x1, y2 - y1);
    lastEffectClearRect = next;
  }

  function traceButtonPath(target, rect, radius, inflate = 0){
    const x = rect.x - inflate;
    const y = rect.y - inflate;
    const w = rect.w + (inflate * 2);
    const h = rect.h + (inflate * 2);
    const r = clamp(radius + inflate, 0, Math.min(w, h) / 2);

    target.moveTo(x + r, y);
    target.lineTo(x + w, y);
    target.lineTo(x + w, y + h);
    target.lineTo(x + r, y + h);
    target.quadraticCurveTo(x, y + h, x, y + h - r);
    target.lineTo(x, y + r);
    target.quadraticCurveTo(x, y, x + r, y);
  }

  function resetFlamelet(flamelet, scatter = false){
    const edgeRoll = Math.random();
    flamelet.edge = fireUsesCollapsedHandle()
      ? "button"
      : edgeRoll < 0.34
        ? "top"
        : edgeRoll < 0.52
          ? "bottom"
          : edgeRoll < 0.80
            ? "left"
            : "button";
    flamelet.t = Math.random();
    flamelet.life = 0.46 + Math.random() * 0.72;
    flamelet.age = scatter ? Math.random() * flamelet.life : 0;
    flamelet.height = 10 + Math.random() * 28;
    flamelet.width = 3.8 + Math.random() * 7.8;
    flamelet.lean = (Math.random() - 0.5) * 0.72;
    flamelet.phase = Math.random() * Math.PI * 2;
    flamelet.heat = 0.62 + Math.random() * 0.38;
    flamelet.igniteAt = edgeIgnitionProgress(flamelet.edge, flamelet.t);
  }

  function rimHorizontalX(menu, t, leftPad = 10, rightPad = 58){
    const left = menu.x + leftPad;
    const right = Math.min(menu.x + menu.w - rightPad, canvasW - 54);
    return left + Math.max(0, right - left) * t;
  }

  function rebuildFlamelets(){
    const count = clamp(Math.round(canvasW / 28), 42, 76);
    flamelets = Array.from({ length: count }, () => {
      const flamelet = {};
      resetFlamelet(flamelet, true);
      return flamelet;
    });
  }

  function flameBase(flamelet, shape){
    const menu = shape.menu;
    const button = shape.button;

    if (flamelet.edge === "top"){
      return {
        x: rimHorizontalX(menu, flamelet.t),
        y: menu.y + 2,
        nx: 0,
        ny: -1,
        tx: 1,
        ty: 0
      };
    }

    if (flamelet.edge === "bottom"){
      return {
        x: rimHorizontalX(menu, flamelet.t, 8, 60),
        y: menu.y + menu.h - 1,
        nx: 0,
        ny: 1,
        tx: 1,
        ty: 0
      };
    }

    if (flamelet.edge === "button"){
      return {
        x: button.x + 5,
        y: button.y + 8 + (button.h - 16) * flamelet.t,
        nx: -1,
        ny: 0,
        tx: 0,
        ty: 1
      };
    }

    return {
      x: menu.x + 2,
      y: menu.y + 12 + (menu.h - 24) * flamelet.t,
      nx: -1,
      ny: 0,
      tx: 0,
      ty: 1
    };
  }

  function drawFlamelets(shape, now){
    const dt = clamp(((now - lastFlameNow) || 16) / 1000, 0.008, 0.045);
    lastFlameNow = now;
    flameLightBursts.length = 0;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    for (const flamelet of flamelets){
      let gate = ignitionGate(flamelet.igniteAt, 0.16);
      if (gate <= 0.025) continue;

      flamelet.age += dt * (0.72 + gate * 0.28);
      if (flamelet.age >= flamelet.life){
        resetFlamelet(flamelet);
        gate = ignitionGate(flamelet.igniteAt, 0.16);
        if (gate <= 0.025) continue;
      }

      const base = flameBase(flamelet, shape);
      const life = clamp(flamelet.age / flamelet.life, 0, 1);
      const swell = Math.sin(life * Math.PI);
      const fade = Math.pow(1 - life, 0.62);
      const flicker = Math.sin((now * 0.012) + flamelet.phase) * 0.5 + 0.5;
      const height = flamelet.height * (0.42 + swell * 0.86) * (0.72 + flicker * 0.32) * (0.70 + gate * 0.30);
      const width = flamelet.width * (0.72 + swell * 0.96);
      const lean = flamelet.lean + Math.sin((now * 0.004) + flamelet.phase) * 0.28;

      const tipX = base.x + base.nx * height + base.tx * lean * height;
      const tipY = base.y + base.ny * height + base.ty * lean * height;
      const leftX = base.x - base.tx * width;
      const leftY = base.y - base.ty * width;
      const rightX = base.x + base.tx * width;
      const rightY = base.y + base.ty * width;
      const midX = base.x + base.nx * height * 0.36 + base.tx * lean * height * 0.48;
      const midY = base.y + base.ny * height * 0.36 + base.ty * lean * height * 0.48;
      const alpha = fade * flamelet.heat * 0.45 * gate;
      if (alpha <= 0.003) continue;
      const reach = clamp(height / Math.max(1, flamelet.height), 0, 1.5);

      const flameGradient = ctx.createRadialGradient(
        base.x,
        base.y,
        0,
        midX,
        midY,
        Math.max(1, height * 0.92)
      );

      if (height > 15 && alpha > 0.035){
        flameLightBursts.push({
          x: midX,
          y: midY,
          radius: clamp(height * (1.8 + reach * 1.2), 28, 92),
          power: clamp(alpha * (0.68 + reach * 0.48), 0, 0.42)
        });
      }

      flameGradient.addColorStop(0, `rgba(255, 242, 178, ${alpha * 0.95})`);
      flameGradient.addColorStop(0.18, `rgba(255, 132, 32, ${alpha * 0.72})`);
      flameGradient.addColorStop(0.46, `rgba(214, 46, 10, ${alpha * 0.32})`);
      flameGradient.addColorStop(1, "rgba(255, 54, 8, 0)");

      ctx.fillStyle = flameGradient;
      ctx.beginPath();
      ctx.moveTo(leftX, leftY);
      ctx.quadraticCurveTo(midX - base.tx * width * 0.72, midY - base.ty * width * 0.72, tipX, tipY);
      ctx.quadraticCurveTo(midX + base.tx * width * 0.72, midY + base.ty * width * 0.72, rightX, rightY);
      ctx.quadraticCurveTo(base.x, base.y, leftX, leftY);
      ctx.fill();

      const coreGradient = ctx.createLinearGradient(base.x, base.y, tipX, tipY);
      coreGradient.addColorStop(0, `rgba(255, 236, 170, ${alpha * 0.62})`);
      coreGradient.addColorStop(0.34, `rgba(255, 112, 24, ${alpha * 0.32})`);
      coreGradient.addColorStop(1, "rgba(255, 94, 18, 0)");
      ctx.strokeStyle = coreGradient;
      ctx.lineWidth = Math.max(0.65, width * 0.24);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();
    }

    ctx.restore();
  }

  function ignitionHeadPosition(shape){
    const menu = shape.menu;
    const button = shape.button;
    const progress = fireIgnitionProgress;

    if (fireUsesCollapsedHandle()){
      const amount = segmentAmount(progress, 0.06, 0.82);
      return {
        x: button.x + 4,
        y: button.y + button.h - 8 - (button.h - 16) * amount
      };
    }

    if (progress < 0.34){
      const amount = segmentAmount(progress, 0.04, 0.34);
      return {
        x: menu.x + 16 + (menu.w - 72) * amount,
        y: menu.y + menu.h + 3
      };
    }

    if (progress < 0.48){
      const amount = segmentAmount(progress, 0.14, 0.48);
      return {
        x: menu.x + 2,
        y: menu.y + menu.h - 18 - (menu.h - 40) * amount
      };
    }

    if (progress < 0.74){
      const amount = segmentAmount(progress, 0.42, 0.74);
      return {
        x: menu.x + 18 + (menu.w - 72) * amount,
        y: menu.y + 2
      };
    }

    const amount = segmentAmount(progress, 0.58, 0.88);
    return {
      x: button.x + 4,
      y: button.y + button.h - 10 - (button.h - 20) * amount
    };
  }

  function drawIgnitionHeadLight(shape, now){
    if (!fireZoneActive || fireIgnitionProgress >= 0.985) return;

    const collapsedHandle = fireUsesCollapsedHandle();
    if (!collapsedHandle) return;

    const head = ignitionHeadPosition(shape);
    const pulse = 0.5 + Math.sin(now * 0.012) * 0.5;
    const sourceX = collapsedHandle ? head.x - 18 : head.x;
    const sourceY = head.y;
    const radius = collapsedHandle ? 54 + pulse * 12 : 92 + pulse * 24;
    const strength = collapsedHandle ? 0.52 : 1;
    const light = ctx.createRadialGradient(sourceX, sourceY, 0, sourceX, sourceY, radius);

    light.addColorStop(0, `rgba(255, 250, 206, ${0.34 * strength})`);
    light.addColorStop(0.17, `rgba(255, 196, 92, ${0.22 * strength})`);
    light.addColorStop(0.42, `rgba(255, 96, 24, ${0.080 * strength})`);
    light.addColorStop(1, "rgba(255, 76, 12, 0)");

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.filter = `${collapsedHandle ? "blur(12px)" : "blur(8px)"} saturate(1.08)`;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(sourceX, sourceY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function traceIgnitionLine(x1, y1, x2, y2, amount){
    if (amount <= 0) return false;
    const visible = clamp(amount, 0, 1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + (x2 - x1) * visible, y1 + (y2 - y1) * visible);
    return true;
  }

  function traceIgnitionCorner(x1, y1, cx, cy, x2, y2, amount){
    if (amount <= 0) return false;
    const t = clamp(amount, 0, 1);
    const c1x = lerp(x1, cx, t);
    const c1y = lerp(y1, cy, t);
    const c2x = lerp(cx, x2, t);
    const c2y = lerp(cy, y2, t);
    const endX = lerp(c1x, c2x, t);
    const endY = lerp(c1y, c2y, t);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(c1x, c1y, endX, endY);
    return true;
  }

  function drawIgnitionRimSegments(shape, pulse, lineWidth, alpha, shadowBlur){
    const menu = shape.menu;
    const button = shape.button;
    const progress = fireIgnitionProgress;

    if (fireUsesCollapsedHandle()){
      const bottom = segmentAmount(progress, 0.06, 0.24);
      const bottomCorner = segmentAmount(progress, 0.20, 0.34);
      const left = segmentAmount(progress, 0.30, 0.78);
      const topCorner = segmentAmount(progress, 0.66, 0.84);
      const top = segmentAmount(progress, 0.78, 0.94);
      const rimAlpha = alpha * (lineWidth > 3 ? 0.54 : 0.46);
      const rimWidth = lineWidth > 3 ? Math.min(lineWidth, 5.2) : Math.min(lineWidth, 1.4);
      const rimBlur = lineWidth > 3 ? Math.min(shadowBlur, 18) : Math.min(shadowBlur, 7);
      const r = Math.min(18, button.h * 0.42, button.w * 0.42);
      const leftX = button.x + 5;
      const topY = button.y + 5;
      const bottomY = button.y + button.h - 5;

      ctx.shadowColor = `rgba(255, 178, 66, ${rimAlpha * 1.15})`;
      ctx.shadowBlur = rimBlur;
      ctx.strokeStyle = `rgba(255, 174, 64, ${rimAlpha})`;
      ctx.lineWidth = rimWidth;

      if (traceIgnitionLine(leftX + r, bottomY, button.x + button.w - 8, bottomY, bottom)) ctx.stroke();
      if (traceIgnitionCorner(leftX + r, bottomY, leftX, bottomY, leftX, bottomY - r, bottomCorner)) ctx.stroke();
      if (traceIgnitionLine(leftX, bottomY - r, leftX, topY + r, left)) ctx.stroke();
      if (traceIgnitionCorner(leftX, topY + r, leftX, topY, leftX + r, topY, topCorner)) ctx.stroke();
      if (traceIgnitionLine(leftX + r, topY, button.x + button.w - 8, topY, top)) ctx.stroke();
      return;
    }

    const bottom = segmentAmount(progress, 0.04, 0.34);
    const bottomCorner = segmentAmount(progress, 0.28, 0.44);
    const left = segmentAmount(progress, 0.36, 0.58);
    const topCorner = segmentAmount(progress, 0.52, 0.66);
    const top = segmentAmount(progress, 0.60, 0.78);
    const buttonSide = segmentAmount(progress, 0.58, 0.88);
    const r = 22;
    const leftX = menu.x + 1;
    const topY = menu.y + 1;
    const bottomY = menu.y + menu.h + 1;

    ctx.shadowColor = `rgba(255, 178, 66, ${alpha * 1.15})`;
    ctx.shadowBlur = shadowBlur;
    ctx.strokeStyle = `rgba(255, 174, 64, ${alpha})`;
    ctx.lineWidth = lineWidth;

    if (traceIgnitionLine(leftX + r, bottomY, menu.x + menu.w - 48, bottomY, bottom)) ctx.stroke();
    if (traceIgnitionCorner(leftX + r, bottomY, leftX, bottomY, leftX, bottomY - r, bottomCorner)) ctx.stroke();
    if (traceIgnitionLine(leftX, bottomY - r, leftX, topY + r, left)) ctx.stroke();
    if (traceIgnitionCorner(leftX, topY + r, leftX, topY, leftX + r, topY, topCorner)) ctx.stroke();
    if (traceIgnitionLine(leftX + r, topY, menu.x + menu.w - 48, topY, top)) ctx.stroke();
    if (traceIgnitionLine(button.x + 4, button.y + button.h - 10, button.x + 4, button.y + 10, buttonSide)) ctx.stroke();
  }

  function drawFireLightSpill(shape, now){
    const pulse = 0.5 + Math.sin(now * 0.0048) * 0.5;
    const menu = shape.menu;
    const button = shape.button;
    const collapsedHandle = fireUsesCollapsedHandle();
    const steady = segmentAmount(fireIgnitionProgress, 0.20, 0.92);

    drawIgnitionHeadLight(shape, now);
    if (steady <= 0.02) return;

    ctx.save();
    ctx.globalAlpha *= steady;
    ctx.globalCompositeOperation = "screen";
    ctx.filter = "blur(14px) saturate(1.02)";

    const panelGlow = getCachedEffectPath(shape, `fire-spill:${collapsedHandle ? 1 : 0}`, (path) => {
      if (!collapsedHandle) tracePanelPath(path, menu, 22, 8);
      traceButtonPath(path, button, 18, 8);
    });

    ctx.shadowColor = `rgba(255, 196, 92, ${0.26 + pulse * 0.08})`;
    ctx.shadowBlur = 58;
    ctx.strokeStyle = `rgba(255, 206, 112, ${0.075 + pulse * 0.035})`;
    ctx.lineWidth = 30;
    ctx.stroke(panelGlow);

    ctx.filter = "blur(28px) saturate(0.95)";
    ctx.shadowColor = `rgba(210, 58, 16, ${0.10 + pulse * 0.04})`;
    ctx.shadowBlur = 94;
    ctx.strokeStyle = `rgba(255, 84, 18, ${0.025 + pulse * 0.014})`;
    ctx.lineWidth = 64;
    ctx.stroke(panelGlow);

    ctx.filter = "blur(9px) saturate(1.04)";
    const buttonLight = ctx.createRadialGradient(
      button.x + button.w * 0.35,
      button.y + button.h * 0.5,
      0,
      button.x + button.w * 0.35,
      button.y + button.h * 0.5,
      178
    );
    buttonLight.addColorStop(0, `rgba(255, 236, 166, ${0.24 + pulse * 0.05})`);
    buttonLight.addColorStop(0.20, `rgba(255, 174, 72, ${0.12 + pulse * 0.03})`);
    buttonLight.addColorStop(0.54, `rgba(220, 58, 14, ${0.035 + pulse * 0.014})`);
    buttonLight.addColorStop(1, "rgba(255, 80, 10, 0)");
    ctx.fillStyle = buttonLight;
    ctx.fillRect(button.x - 138, button.y - 114, 276, button.h + 228);

    if (!collapsedHandle){
      ctx.filter = "blur(7px) saturate(1.02)";
      const upperLight = ctx.createLinearGradient(menu.x, menu.y - 24, menu.x, menu.y + 44);
      upperLight.addColorStop(0, "rgba(255, 245, 180, 0)");
      upperLight.addColorStop(0.42, `rgba(255, 226, 148, ${0.055 + pulse * 0.02})`);
      upperLight.addColorStop(1, "rgba(255, 112, 24, 0)");
      ctx.fillStyle = upperLight;
      ctx.fillRect(menu.x - 34, menu.y - 28, menu.w + 46, 86);

      const lowerLight = ctx.createLinearGradient(menu.x, menu.y + menu.h - 34, menu.x, menu.y + menu.h + 34);
      lowerLight.addColorStop(0, "rgba(255, 145, 40, 0)");
      lowerLight.addColorStop(0.52, `rgba(255, 186, 82, ${0.045 + pulse * 0.016})`);
      lowerLight.addColorStop(1, "rgba(255, 92, 18, 0)");
      ctx.fillStyle = lowerLight;
      ctx.fillRect(menu.x - 34, menu.y + menu.h - 42, menu.w + 46, 84);
    }

    ctx.filter = "blur(8px) saturate(1.04)";
    for (const burst of flameLightBursts){
      const radius = burst.radius;
      const power = burst.power * (0.84 + pulse * 0.22);
      const emission = ctx.createRadialGradient(burst.x, burst.y, 0, burst.x, burst.y, radius);

      emission.addColorStop(0, `rgba(255, 246, 186, ${power * 0.46})`);
      emission.addColorStop(0.20, `rgba(255, 196, 92, ${power * 0.32})`);
      emission.addColorStop(0.54, `rgba(255, 116, 34, ${power * 0.12})`);
      emission.addColorStop(1, "rgba(255, 80, 14, 0)");

      ctx.fillStyle = emission;
      ctx.fillRect(burst.x - radius, burst.y - radius, radius * 2, radius * 2);
    }

    ctx.restore();
  }

  function drawRimGlow(shape, now){
    const pulse = 0.5 + (Math.sin(now * 0.006) * 0.5);
    const menu = shape.menu;
    const button = shape.button;
    const collapsedHandle = fireUsesCollapsedHandle();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (collapsedHandle){
      drawIgnitionRimSegments(shape, pulse, 8.5, 0.22 + pulse * 0.08, 30);
      drawIgnitionRimSegments(shape, pulse, 2.2, 0.44 + pulse * 0.10, 12);
    }

    const settled = collapsedHandle
      ? segmentAmount(fireIgnitionProgress, 0.74, 1)
      : segmentAmount(fireIgnitionProgress, 0.12, 0.72);
    if (settled <= 0.02){
      ctx.restore();
      return;
    }

    ctx.globalAlpha *= settled;

    const glow = getCachedEffectPath(shape, `fire-rim:${collapsedHandle ? 1 : 0}`, (path) => {
      if (!collapsedHandle) tracePanelPath(path, menu, 22, 2);
      traceButtonPath(path, button, 18, 2);
    });

    ctx.shadowColor = `rgba(255, 170, 58, ${0.42 + pulse * 0.12})`;
    ctx.shadowBlur = 32;
    ctx.strokeStyle = `rgba(255, 146, 38, ${0.24 + pulse * 0.08})`;
    ctx.lineWidth = 8.5;
    ctx.stroke(glow);

    ctx.shadowColor = "rgba(255, 224, 154, 0.78)";
    ctx.shadowBlur = 12;
    ctx.strokeStyle = "rgba(255, 230, 170, 0.62)";
    ctx.lineWidth = 2.2;
    ctx.stroke(glow);

    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 140, 36, 0.36)";
    ctx.lineWidth = 1;
    ctx.stroke(glow);
    ctx.restore();
  }

  function rebuildEmbers(){
    const count = clamp(Math.round(canvasW / 22), 54, 94);
    embers = Array.from({ length: count }, () => ({ age: 0, life: 1 }));
    const shape = refreshShape();
    embers.forEach((ember) => resetEmber(ember, shape, true));
  }

  function resetEmber(ember, shape, scatter = false){
    const menu = shape.menu;
    const button = shape.button;
    const collapsedHandle = fireUsesCollapsedHandle();
    const side = collapsedHandle ? 3 : Math.floor(Math.random() * 4);
    let x = menu.x;
    let y = menu.y;
    let vx = 0;
    let vy = 0;
    let edge = "top";
    let edgeT = Math.random();

    if (collapsedHandle){
      edge = "button";
      edgeT = Math.random();
      x = button.x + 2 + Math.random() * 8;
      y = button.y + 8 + ((button.h - 16) * edgeT);
      vx = -5 - (Math.random() * 13);
      vy = -12 - (Math.random() * 22);
    } else if (side === 0){
      edge = "top";
      edgeT = Math.random();
      x = rimHorizontalX(menu, edgeT, 8, 56);
      y = menu.y - 4;
      vx = (Math.random() - 0.5) * 24;
      vy = -22 - (Math.random() * 28);
    } else if (side === 1){
      edge = "bottom";
      edgeT = Math.random();
      x = rimHorizontalX(menu, edgeT, 8, 58);
      y = menu.y + menu.h + 4;
      vx = (Math.random() - 0.5) * 22;
      vy = -6 - (Math.random() * 22);
    } else if (side === 2){
      edge = "left";
      edgeT = Math.random();
      x = menu.x - 4;
      y = menu.y + (edgeT * menu.h);
      vx = -14 - (Math.random() * 26);
      vy = -10 - (Math.random() * 24);
    } else {
      edge = "button";
      edgeT = Math.random();
      x = button.x - 5;
      y = button.y + (edgeT * button.h);
      vx = -15 - (Math.random() * 26);
      vy = -10 - (Math.random() * 24);
    }

    ember.edge = edge;
    ember.edgeT = edgeT;
    ember.igniteAt = edgeIgnitionProgress(edge, edgeT);
    ember.x = x;
    ember.y = y;
    ember.vx = vx;
    ember.vy = vy;
    ember.age = scatter ? Math.random() * 1.8 : 0;
    ember.life = collapsedHandle ? 0.42 + Math.random() * 0.56 : 0.72 + Math.random() * 1.10;
    ember.size = collapsedHandle ? 0.42 + Math.random() * 0.92 : 0.52 + Math.random() * 1.55;
    ember.phase = Math.random() * Math.PI * 2;
    ember.heat = 0.62 + Math.random() * 0.38;
  }

  function drawEmbers(shape, now){
    const dt = clamp(((now - lastEmberNow) || 16) / 1000, 0.008, 0.045);
    lastEmberNow = now;
    const collapsedHandle = fireUsesCollapsedHandle();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const ember of embers){
      let gate = ignitionGate(ember.igniteAt, 0.18);
      if (gate <= 0.025) continue;

      ember.age += dt * (0.72 + gate * 0.28);
      if (ember.age >= ember.life){
        resetEmber(ember, shape);
        gate = ignitionGate(ember.igniteAt, 0.18);
        if (gate <= 0.025) continue;
      }

      const life = clamp(ember.age / ember.life, 0, 1);
      const fade = Math.sin((1 - life) * Math.PI * 0.5);
      const drift = Math.sin((now * 0.002) + ember.phase) * (collapsedHandle ? 2.4 : 6);

      ember.vx *= 0.995;
      ember.vy -= (collapsedHandle ? 2.8 : 5.2) * dt;
      ember.x += (ember.vx + drift) * dt;
      ember.y += ember.vy * dt;

      if (collapsedHandle && (ember.x < shape.button.x - 58 || ember.y < shape.button.y - 42 || ember.y > shape.button.y + shape.button.h + 42)){
        resetEmber(ember, shape);
        continue;
      }

      const size = ember.size * (0.88 + life * 1.05);
      const alpha = fade * ember.heat * 0.66 * gate;
      if (alpha <= 0.003) continue;
      const glow = ctx.createRadialGradient(ember.x, ember.y, 0, ember.x, ember.y, size * 7.4);

      glow.addColorStop(0, `rgba(255, 240, 174, ${Math.min(1, alpha * 1.08)})`);
      glow.addColorStop(0.16, `rgba(255, 142, 44, ${alpha * 0.88})`);
      glow.addColorStop(0.42, `rgba(228, 52, 12, ${alpha * 0.40})`);
      glow.addColorStop(0.72, `rgba(255, 82, 16, ${alpha * 0.14})`);
      glow.addColorStop(1, "rgba(255, 84, 18, 0)");

      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ember.x, ember.y, size * 7.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255, 242, 190, ${alpha * 0.82})`;
      ctx.beginPath();
      ctx.arc(ember.x, ember.y, Math.max(0.55, size * 0.55), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawQuenchingFire(shape, now){
    if (!waterZoneActive || !waterQuenchHasFire) return;

    const progress = quenchProgress(now);
    const fireFade = 1 - smoothstep((progress - 0.70) / 0.26);
    const exitFade = 1 - smoothstep((progress - 0.78) / 0.22);
    const heat = Math.pow(1 - progress, 0.46) * exitFade;
    const steam = smoothstep((progress - 0.44) / 0.24) * Math.sin(progress * Math.PI) * exitFade;

    if (fireFade > 0.02){
      const previousIgnition = fireIgnitionProgress;
      fireIgnitionProgress = quenchFireIgnitionProgress;

      ctx.save();
      ctx.globalAlpha *= 0.92 * fireFade;
      ctx.globalCompositeOperation = "lighter";

      ctx.save();
      ctx.globalAlpha *= 0.50;
      drawFireLightSpill(shape, now);
      ctx.restore();

      drawFlamelets(shape, now);
      drawRimGlow(shape, now);
      drawEmbers(shape, now);
      ctx.restore();

      fireIgnitionProgress = previousIgnition;
    }

    if (fireFade <= 0.02 && heat <= 0.018 && steam <= 0.018) return;

    const pulse = 0.5 + Math.sin(now * 0.013) * 0.5;
    const outline = getCachedEffectPath(shape, "quench-button", (path) => {
      traceButtonPath(path, shape.button, 18, 1);
    });

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.shadowColor = `rgba(255, 156, 48, ${0.36 * heat})`;
    ctx.shadowBlur = 24;
    ctx.strokeStyle = `rgba(255, 116, 32, ${(0.30 + pulse * 0.10) * heat})`;
    ctx.lineWidth = 6.6 + heat * 3.0;
    ctx.stroke(outline);

    ctx.shadowColor = `rgba(240, 255, 255, ${0.26 * steam})`;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = `rgba(240, 255, 255, ${0.16 + steam * 0.42})`;
    ctx.lineWidth = 1.6 + steam * 2.2;
    ctx.stroke(outline);

    const button = shape.button;
    const vaporGlow = ctx.createRadialGradient(button.x + 7, button.y + button.h * 0.5, 0, button.x + 7, button.y + button.h * 0.5, 112);
    vaporGlow.addColorStop(0, `rgba(255, 252, 232, ${0.11 * heat})`);
    vaporGlow.addColorStop(0.24, `rgba(228, 255, 255, ${0.14 * steam})`);
    vaporGlow.addColorStop(0.62, `rgba(118, 220, 255, ${0.055 * steam})`);
    vaporGlow.addColorStop(1, "rgba(92, 210, 255, 0)");
    ctx.fillStyle = vaporGlow;
    ctx.fillRect(button.x - 110, button.y - 82, 160, button.h + 164);
    ctx.restore();
  }

  function drawQuenchSteamJets(shape, now){
    if (!waterZoneActive) return;

    const progress = quenchProgress(now);
    const button = shape.button;
    const enter = smoothstep((progress - 0.54) / 0.20);
    const exit = 1 - smoothstep((progress - 0.86) / 0.12);
    const strength = enter * exit;
    if (strength <= 0.015) return;
    const shrink = 0.34 + (exit * 0.66);

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.lineCap = "round";

    for (let i = 0; i < 8; i++){
      const t = (i + 0.5) / 8;
      const phase = (now * 0.0028) + (i * 1.37);
      const pulse = 0.5 + Math.sin(phase) * 0.5;
      const baseX = button.x + 5 + Math.sin(phase * 0.7) * 2.4;
      const baseY = button.y + 7 + (button.h - 14) * t;
      const reach = (34 + progress * 82) * (0.72 + pulse * 0.34) * shrink;
      const lift = (28 + progress * 92) * (0.70 + (1 - t) * 0.34 + pulse * 0.18) * shrink;
      const endX = baseX - reach;
      const endY = baseY - lift;

      const jet = ctx.createLinearGradient(baseX, baseY, endX, endY);
      jet.addColorStop(0, `rgba(255, 255, 246, ${0.20 * strength})`);
      jet.addColorStop(0.30, `rgba(222, 252, 255, ${0.16 * strength})`);
      jet.addColorStop(0.72, `rgba(144, 226, 255, ${0.070 * strength})`);
      jet.addColorStop(1, "rgba(116, 210, 255, 0)");

      ctx.shadowColor = `rgba(220, 252, 255, ${0.18 * strength})`;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = jet;
      ctx.lineWidth = (1.1 + pulse * 1.2 + strength * 1.1) * (0.60 + exit * 0.40);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.bezierCurveTo(
        baseX - reach * 0.30,
        baseY - lift * 0.18 + Math.sin(phase) * 10,
        baseX - reach * 0.62,
        baseY - lift * 0.58 + Math.cos(phase * 0.8) * 16,
        endX,
        endY
      );
      ctx.stroke();
    }

    ctx.restore();
  }

  function quenchPlumeSource(shape){
    const menu = shape.menu;
    const button = shape.button;

    if (fireUsesCollapsedHandle()){
      return {
        x: button.x + 3 + Math.random() * 8,
        y: button.y + 7 + (button.h - 14) * Math.random(),
        nx: -1,
        ny: 0
      };
    }

    const roll = Math.random();
    if (roll < 0.35){
      return {
        x: rimHorizontalX(menu, Math.random(), 8, 56),
        y: menu.y + 2,
        nx: 0,
        ny: -1
      };
    }
    if (roll < 0.55){
      return {
        x: rimHorizontalX(menu, Math.random(), 8, 58),
        y: menu.y + menu.h - 1,
        nx: 0,
        ny: 1
      };
    }
    if (roll < 0.78){
      return {
        x: menu.x + 2,
        y: menu.y + 14 + (menu.h - 28) * Math.random(),
        nx: -1,
        ny: 0
      };
    }

    return waterButtonPoint(button, Math.random());
  }

  function resetQuenchPlume(plume, shape, scatter = false){
    const base = quenchPlumeSource(shape);
    const collapsedHandle = fireUsesCollapsedHandle();
    const outward = collapsedHandle ? 1.22 : 1;

    plume.x = base.x + base.nx * (5 + Math.random() * (collapsedHandle ? 10 : 16));
    plume.y = base.y + (Math.random() - 0.5) * (collapsedHandle ? 16 : 28);
    plume.vx = base.nx * (18 + Math.random() * (collapsedHandle ? 38 : 34)) * outward + (Math.random() - 0.5) * 10;
    plume.vy = -32 - Math.random() * (collapsedHandle ? 58 : 50);
    plume.life = 1.35 + Math.random() * 1.35;
    plume.age = scatter ? Math.random() * plume.life : -(Math.random() * 0.48);
    plume.size = collapsedHandle ? 20 + Math.random() * 46 : 26 + Math.random() * 54;
    plume.phase = Math.random() * Math.PI * 2;
    plume.spin = (Math.random() - 0.5) * 0.8;
    plume.alpha = 0.62 + Math.random() * 0.30;
    plume.heat = 0.55 + Math.random() * 0.45;
  }

  function drawQuenchPlumes(shape, now){
    if (!waterZoneActive) return;

    const progress = quenchProgress(now);
    const rise = smoothstep((progress - 0.42) / 0.24);
    const fadeOut = 1 - smoothstep((progress - 0.70) / 0.28);
    const strength = rise * fadeOut;
    if (strength <= 0.015) return;

    const dt = clamp(((now - lastWaterNow) || 16) / 1000, 0.008, 0.045);

    ctx.save();
    ctx.globalCompositeOperation = "screen";

    for (const plume of quenchPlumes){
      plume.age += dt * (0.88 + progress * 0.50);
      if (plume.age >= plume.life){
        if (progress < 0.86) resetQuenchPlume(plume, shape);
        else continue;
      }
      if (plume.age < 0) continue;

      const life = clamp(plume.age / plume.life, 0, 1);
      const fade = Math.sin(life * Math.PI) * strength * plume.alpha;
      const swirl = Math.sin(now * 0.0024 + plume.phase) * (8 + progress * 13);
      const lift = 12 + progress * 22;

      plume.vx *= 0.986;
      plume.vy -= lift * dt;
      plume.x += (plume.vx + swirl) * dt;
      plume.y += plume.vy * dt;
      if (fade <= 0.003) continue;

      const radius = plume.size * (0.46 + life * 1.16) * (1 + progress * 0.34);

      const vapor = ctx.createRadialGradient(plume.x, plume.y, 0, plume.x, plume.y, radius);
      vapor.addColorStop(0, `rgba(248, 255, 255, ${0.34 * fade})`);
      vapor.addColorStop(0.22, `rgba(216, 248, 255, ${0.22 * fade})`);
      vapor.addColorStop(0.52, `rgba(136, 216, 255, ${0.095 * fade})`);
      vapor.addColorStop(1, "rgba(76, 164, 232, 0)");
      ctx.fillStyle = vapor;
      ctx.beginPath();
      ctx.arc(plume.x, plume.y, radius, 0, Math.PI * 2);
      ctx.fill();

      if (progress < 0.58 && life < 0.50){
        const hotAlpha = fade * plume.heat * (1 - (progress / 0.58)) * (1 - life * 1.7);
        const spark = ctx.createRadialGradient(plume.x, plume.y, 0, plume.x, plume.y, 12 + plume.size * 0.28);
        spark.addColorStop(0, `rgba(255, 232, 174, ${0.18 * hotAlpha})`);
        spark.addColorStop(0.34, `rgba(255, 120, 38, ${0.10 * hotAlpha})`);
        spark.addColorStop(1, "rgba(255, 88, 20, 0)");
        ctx.fillStyle = spark;
        ctx.beginPath();
        ctx.arc(plume.x, plume.y, 12 + plume.size * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function waterButtonPoint(button, t){
    return {
      x: button.x + 5,
      y: button.y + 8 + (button.h - 16) * t,
      nx: -1,
      ny: 0
    };
  }

  function waterEdgePoint(shape){
    const menu = shape.menu;
    const button = shape.button;

    if (fireUsesCollapsedHandle()){
      return waterButtonPoint(button, Math.random());
    }

    const roll = Math.random();
    if (roll < 0.34){
      return {
        x: menu.x + 12 + (menu.w - 72) * Math.random(),
        y: menu.y + 2,
        nx: 0,
        ny: -1
      };
    }
    if (roll < 0.58){
      return {
        x: menu.x + 12 + (menu.w - 72) * Math.random(),
        y: menu.y + menu.h - 2,
        nx: 0,
        ny: 1
      };
    }
    if (roll < 0.78){
      return {
        x: menu.x + 3,
        y: menu.y + 14 + (menu.h - 28) * Math.random(),
        nx: -1,
        ny: 0
      };
    }
    return waterButtonPoint(button, Math.random());
  }

  function resetWaterBubble(bubble, shape, scatter = false){
    const base = waterEdgePoint(shape);
    const collapsedHandle = fireUsesCollapsedHandle();

    bubble.x = base.x + base.nx * (4 + Math.random() * (collapsedHandle ? 14 : 24)) + (Math.random() - 0.5) * 8;
    bubble.y = base.y + (Math.random() - 0.5) * (collapsedHandle ? 12 : 20);
    bubble.vx = base.nx * (4 + Math.random() * (collapsedHandle ? 16 : 24)) + (Math.random() - 0.5) * 10;
    bubble.vy = -12 - Math.random() * (collapsedHandle ? 22 : 34);
    bubble.life = collapsedHandle ? 0.92 + Math.random() * 1.15 : 1.0 + Math.random() * 1.55;
    bubble.age = scatter ? Math.random() * bubble.life : Math.random() * 0.16;
    bubble.size = collapsedHandle ? 1.2 + Math.random() * 3.2 : 1.4 + Math.random() * 4.4;
    bubble.phase = Math.random() * Math.PI * 2;
    bubble.alpha = 0.42 + Math.random() * 0.42;
  }

  function resetSplashDrop(drop, shape, scatter = false){
    const base = waterEdgePoint(shape);
    const collapsedHandle = fireUsesCollapsedHandle();

    drop.x = base.x + base.nx * (2 + Math.random() * 8);
    drop.y = base.y + (Math.random() - 0.5) * (collapsedHandle ? 18 : 28);
    drop.vx = base.nx * (24 + Math.random() * (collapsedHandle ? 34 : 48)) + (Math.random() - 0.5) * 18;
    drop.vy = -28 + Math.random() * 34;
    drop.life = 0.34 + Math.random() * 0.62;
    drop.age = scatter ? Math.random() * drop.life : Math.random() * 0.08;
    drop.size = 0.85 + Math.random() * 2.2;
    drop.phase = Math.random() * Math.PI * 2;
  }

  function resetVaporPuff(puff, shape, scatter = false){
    const base = waterEdgePoint(shape);
    const collapsedHandle = fireUsesCollapsedHandle();

    puff.x = base.x + base.nx * (10 + Math.random() * 22);
    puff.y = base.y + (Math.random() - 0.5) * (collapsedHandle ? 36 : 58);
    puff.vx = base.nx * (8 + Math.random() * 18) + (Math.random() - 0.5) * 8;
    puff.vy = -8 - Math.random() * 18;
    puff.life = 0.95 + Math.random() * 1.45;
    puff.age = scatter ? Math.random() * puff.life : Math.random() * 0.12;
    puff.size = collapsedHandle ? 18 + Math.random() * 38 : 24 + Math.random() * 54;
    puff.phase = Math.random() * Math.PI * 2;
  }

  function rebuildWaterEffects(){
    const bubbleCount = clamp(Math.round(canvasW / 30), 42, 86);
    const splashCount = clamp(Math.round(canvasW / 52), 22, 44);
    const puffCount = clamp(Math.round(canvasW / 70), 14, 30);
    const plumeCount = clamp(Math.round(canvasW / 60), 22, 42);
    waterBubbles = Array.from({ length: bubbleCount }, () => ({ age: 0, life: 1 }));
    splashDrops = Array.from({ length: splashCount }, () => ({ age: 0, life: 1 }));
    vaporPuffs = Array.from({ length: puffCount }, () => ({ age: 0, life: 1 }));
    quenchPlumes = Array.from({ length: plumeCount }, () => ({ age: 0, life: 1 }));
    const shape = refreshShape();
    waterBubbles.forEach((bubble) => resetWaterBubble(bubble, shape, true));
    splashDrops.forEach((drop) => resetSplashDrop(drop, shape, true));
    vaporPuffs.forEach((puff) => resetVaporPuff(puff, shape, true));
    quenchPlumes.forEach((plume) => resetQuenchPlume(plume, shape, true));
  }

  function traceWaterOutline(target, shape, inflate = 0){
    if (fireUsesCollapsedHandle()){
      traceButtonPath(target, shape.button, 18, inflate);
      return;
    }

    tracePanelPath(target, shape.menu, 22, inflate);
    traceButtonPath(target, shape.button, 18, inflate);
  }

  function drawWaterLightSpill(shape, now, progress){
    const pulse = 0.5 + Math.sin(now * 0.0042) * 0.5;
    const alpha = 0.24 + progress * 0.76;
    const collapsedHandle = fireUsesCollapsedHandle();

    const outline = getCachedEffectPath(shape, `water-spill:${collapsedHandle ? 1 : 0}`, (path) => {
      traceWaterOutline(path, shape, 8);
    });

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha *= alpha;

    ctx.filter = "blur(15px) saturate(1.06)";
    ctx.shadowColor = `rgba(112, 210, 255, ${0.22 + pulse * 0.08})`;
    ctx.shadowBlur = 58;
    ctx.strokeStyle = `rgba(120, 222, 255, ${0.12 + pulse * 0.035})`;
    ctx.lineWidth = collapsedHandle ? 24 : 34;
    ctx.stroke(outline);

    ctx.filter = "blur(32px) saturate(1.03)";
    ctx.shadowColor = `rgba(38, 132, 220, ${0.12 + pulse * 0.04})`;
    ctx.shadowBlur = 86;
    ctx.strokeStyle = `rgba(50, 150, 255, ${0.045 + pulse * 0.018})`;
    ctx.lineWidth = collapsedHandle ? 50 : 72;
    ctx.stroke(outline);
    ctx.restore();
  }

  function drawWaterRim(shape, now, progress){
    const pulse = 0.5 + Math.sin(now * 0.006) * 0.5;
    const collapsedHandle = fireUsesCollapsedHandle();
    const outline = getCachedEffectPath(shape, `water-rim:${collapsedHandle ? 1 : 0}`, (path) => {
      traceWaterOutline(path, shape, 2);
    });

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha *= progress;

    ctx.shadowColor = `rgba(128, 232, 255, ${0.48 + pulse * 0.16})`;
    ctx.shadowBlur = 26;
    ctx.strokeStyle = `rgba(74, 194, 255, ${0.22 + pulse * 0.08})`;
    ctx.lineWidth = collapsedHandle ? 6.2 : 7.8;
    ctx.stroke(outline);

    ctx.shadowColor = "rgba(224, 252, 255, 0.72)";
    ctx.shadowBlur = 10;
    ctx.strokeStyle = "rgba(210, 250, 255, 0.56)";
    ctx.lineWidth = collapsedHandle ? 1.5 : 1.9;
    ctx.stroke(outline);

    const button = shape.button;
    const waveAmp = 2.2 + pulse * 2.2;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = `rgba(182, 248, 255, ${0.26 + pulse * 0.10})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++){
      const t = i / 24;
      const y = button.y + 8 + (button.h - 16) * t;
      const x = button.x + 5 + Math.sin((t * Math.PI * 5.6) + now * 0.0058) * waveAmp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawVaporPuffs(shape, now, progress){
    const dt = clamp(((now - lastWaterNow) || 16) / 1000, 0.008, 0.045);
    const quenchHeat = waterZoneActive ? Math.pow(1 - quenchProgress(now), 0.72) : 0;
    const steamPhase = Math.max(1 - progress, quenchHeat * 0.86);
    if (steamPhase <= 0.02) return;

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.filter = `blur(${5 + quenchHeat * 3}px) saturate(${0.84 + quenchHeat * 0.10})`;

    for (const puff of vaporPuffs){
      puff.age += dt;
      if (puff.age >= puff.life) resetVaporPuff(puff, shape);

      const life = clamp(puff.age / puff.life, 0, 1);
      const fade = Math.sin((1 - life) * Math.PI * 0.5) * steamPhase;
      const swirl = Math.sin(now * 0.002 + puff.phase) * (7 + quenchHeat * 10);

      puff.x += (puff.vx * (1 + quenchHeat * 0.62) + swirl) * dt;
      puff.y += (puff.vy * (1 + quenchHeat * 1.05) - quenchHeat * 22) * dt;
      if (fade <= 0.003) continue;

      const radius = puff.size * (0.56 + life * 0.92) * (1 + quenchHeat * 0.34);
      const vapor = ctx.createRadialGradient(puff.x, puff.y, 0, puff.x, puff.y, radius);
      vapor.addColorStop(0, `rgba(238, 255, 255, ${(0.16 + quenchHeat * 0.08) * fade})`);
      vapor.addColorStop(0.28, `rgba(178, 236, 255, ${(0.10 + quenchHeat * 0.05) * fade})`);
      vapor.addColorStop(0.68, `rgba(72, 144, 210, ${(0.035 + quenchHeat * 0.022) * fade})`);
      vapor.addColorStop(1, "rgba(80, 160, 220, 0)");

      ctx.fillStyle = vapor;
      ctx.beginPath();
      ctx.arc(puff.x, puff.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawSplashDrops(shape, now, progress){
    const dt = clamp(((now - lastWaterNow) || 16) / 1000, 0.008, 0.045);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const drop of splashDrops){
      drop.age += dt * (0.78 + progress * 0.30);
      if (drop.age >= drop.life) resetSplashDrop(drop, shape);

      const life = clamp(drop.age / drop.life, 0, 1);
      const fade = Math.sin((1 - life) * Math.PI * 0.5) * (0.35 + progress * 0.65);
      const drift = Math.sin(now * 0.006 + drop.phase) * 1.8;

      drop.vx *= 0.986;
      drop.vy += 14 * dt;
      drop.x += (drop.vx + drift) * dt;
      drop.y += drop.vy * dt;
      if (fade <= 0.003) continue;

      const radius = drop.size * (0.85 + life * 0.45);
      const glow = ctx.createRadialGradient(drop.x, drop.y, 0, drop.x, drop.y, radius * 5);
      glow.addColorStop(0, `rgba(235, 255, 255, ${0.56 * fade})`);
      glow.addColorStop(0.22, `rgba(118, 224, 255, ${0.34 * fade})`);
      glow.addColorStop(0.58, `rgba(52, 150, 255, ${0.13 * fade})`);
      glow.addColorStop(1, "rgba(40, 130, 255, 0)");

      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(drop.x, drop.y, radius * 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawWaterBubbles(shape, now, progress){
    const dt = clamp(((now - lastWaterNow) || 16) / 1000, 0.008, 0.045);
    const collapsedHandle = fireUsesCollapsedHandle();

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.lineWidth = 1;

    for (const bubble of waterBubbles){
      bubble.age += dt * (0.78 + progress * 0.34);
      if (bubble.age >= bubble.life) resetWaterBubble(bubble, shape);

      const life = clamp(bubble.age / bubble.life, 0, 1);
      const fade = Math.sin((1 - life) * Math.PI * 0.5) * bubble.alpha * (0.28 + progress * 0.72);
      const wobble = Math.sin(now * 0.003 + bubble.phase) * 10;

      bubble.x += (bubble.vx + wobble) * dt;
      bubble.y += bubble.vy * dt;

      if (collapsedHandle && (bubble.x < shape.button.x - 96 || bubble.y < shape.button.y - 76 || bubble.y > shape.button.y + shape.button.h + 52)){
        resetWaterBubble(bubble, shape);
        continue;
      }
      if (fade <= 0.003) continue;

      const radius = bubble.size * (0.78 + life * 0.56);
      const shell = ctx.createRadialGradient(
        bubble.x - radius * 0.30,
        bubble.y - radius * 0.38,
        0,
        bubble.x,
        bubble.y,
        radius * 2.8
      );
      shell.addColorStop(0, `rgba(242, 255, 255, ${0.34 * fade})`);
      shell.addColorStop(0.26, `rgba(176, 238, 255, ${0.18 * fade})`);
      shell.addColorStop(0.72, `rgba(50, 170, 255, ${0.08 * fade})`);
      shell.addColorStop(1, "rgba(38, 150, 255, 0)");

      ctx.fillStyle = shell;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, radius * 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(214, 252, 255, ${0.38 * fade})`;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawWaterEffect(shape, now){
    const progress = waterProgress(now);
    const quench = quenchProgress(now);
    const vaporLift = progress * smoothstep((quench - 0.46) / 0.32);
    const waterSettle = progress * smoothstep((quench - 0.78) / 0.18);
    syncMenuEffectBodyClasses(now);
    drawQuenchingFire(shape, now);

    if (quench >= 0.42) drawQuenchPlumes(shape, now);
    if (quench >= 0.54) drawQuenchSteamJets(shape, now);
    drawVaporPuffs(shape, now, vaporLift);
    drawWaterLightSpill(shape, now, waterSettle);
    drawWaterRim(shape, now, waterSettle);
    drawSplashDrops(shape, now, waterSettle);
    drawWaterBubbles(shape, now, waterSettle);
    lastWaterNow = now;
  }

  function draw(now){
    rafId = 0;
    if (!hasActiveMenuCanvasEffect(now) || document.hidden || isMobileViewport()){
      syncMenuEffectClasses(now);
      clearEffectCanvas();
      lastMenuEffectFrameAt = 0;
      return;
    }

    if (!menuEffectCanRender(now)){
      syncMenuEffectClasses(now);
      markShapeDirty(80);
      clearEffectCanvas();
      if (hasActiveMenuCanvasEffect(now)) queueMenuEffectFrame();
      return;
    }

    syncMenuEffectClasses(now);
    const frameDelay = getMenuEffectFrameDelay(now);
    if (frameDelay > 0){
      queueMenuEffectFrame(frameDelay);
      return;
    }
    markMenuEffectFrame(now);

    const collapsedState = fireUsesCollapsedHandle();
    if (lastFireCollapsedState !== collapsedState){
      lastFireCollapsedState = collapsedState;
      markShapeDirty(420);
      if (fireZoneActive){
        resetFireForCurrentShape(true, { preserveIgnition: true });
      }
      resetWaterForCurrentShape(false);
    }

    const shape = getShape(now);
    updateIgnition(now);

    if (isRenderable(shape)){
      if (now < forceFullEffectClearUntil || isMenuCollapseMotionActive(now)){
        clearEffectCanvas();
      } else {
        clearEffectCanvas(shape);
      }

      if (fireZoneActive){
        drawFireLightSpill(shape, now);
        drawFlamelets(shape, now);
        drawRimGlow(shape, now);
        drawEmbers(shape, now);
      }

      if (waterZoneActive){
        drawWaterEffect(shape, now);
      }
    } else {
      clearEffectCanvas();
      return;
    }

    if (hasActiveMenuCanvasEffect(now)) queueMenuEffectFrame(menuEffectFrameInterval(now));
    else {
      syncMenuEffectClasses(now);
      clearEffectCanvas();
      lastMenuEffectFrameAt = 0;
    }
  }

  function start(){
    queueMenuEffectFrame();
  }

  function stop(){
    if (rafId) cancelAnimationFrame(rafId);
    if (menuEffectFrameTimer) window.clearTimeout(menuEffectFrameTimer);
    rafId = 0;
    menuEffectFrameTimer = 0;
    lastMenuEffectFrameAt = 0;
  }

  let menuEffectResizeRaf = 0;
  let menuEffectResizeNeedsSlideUpdate = false;

  function queueMenuEffectResize(updateSlideDistance = false){
    menuEffectResizeNeedsSlideUpdate = menuEffectResizeNeedsSlideUpdate || updateSlideDistance;
    if (menuEffectResizeRaf) return;

    menuEffectResizeRaf = requestAnimationFrame(() => {
      const shouldUpdateSlideDistance = menuEffectResizeNeedsSlideUpdate;
      menuEffectResizeRaf = 0;
      menuEffectResizeNeedsSlideUpdate = false;

      resizeCanvas();
      queueFireZone();
      if (shouldUpdateSlideDistance) queueSlideDistanceUpdate();
    });
  };

  if ("ResizeObserver" in window){
    const resizeObserver = new ResizeObserver(() => queueMenuEffectResize(true));
    resizeObserver.observe(container);
    resizeObserver.observe(menuPanel);
  }

  window.addEventListener("resize", () => queueMenuEffectResize());
  window.addEventListener("scroll", queueFireZone, { passive: true });
  window.addEventListener("pageshow", queueFireZone);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else {
      queueFireZone();
    }
  });
  document.addEventListener("pointerdown", () => {
    if (hasActiveMenuEffect()) start();
  }, { passive: true });
  document.addEventListener("keydown", () => {
    if (hasActiveMenuEffect()) start();
  });
  window.addEventListener("va:menu-collapse-started", () => {
    forceFullEffectClearUntil = performance.now() + MENU_COLLAPSE_TRANSITION_MS + 180;
    markShapeDirty(MENU_COLLAPSE_TRANSITION_MS + 140);
    queueFireZone();
    if (hasActiveMenuEffect()) start();
  });
  window.addEventListener("va:menu-collapse-settled", () => {
    forceFullEffectClearUntil = performance.now() + 180;
    markShapeDirty(120);
    queueFireZone();
    if (hasActiveMenuEffect()) start();
  });

  resizeCanvas();
  lastFireCollapsedState = fireUsesCollapsedHandle();
  queueFireZone();
})();

/* ================= CINEMATIC TITLE CONTROL ================= */
const title = document.getElementById("TitleTxt");
let titleVisible = false;
let sheenTimer = null;

function clearTitleClasses(){ title.classList.remove("play-in","play-out","sheen","sway-on"); }
function restartAnims(){ void title.offsetWidth; }
function enableSway(){ title.classList.add("sway-on"); }
function disableSway(){ title.classList.remove("sway-on"); }

const UI_HOVER_SRC    = `${MEDIA}ui_hover_1.mp3`;
const UI_TOGGLE_SRC   = `${MEDIA}UI_Toggle_1.mp3`;
const TITLE_MAIN_SRC  = `${MEDIA}UI_Title_Main.mp3`;
const TITLE_META_SRC  = `${MEDIA}UI_Title_Meta.mp3`;
const TITLE_SHEEN_SRC = `${MEDIA}UI_Title_Sheen.mp3`;
const WATER_ENTER_SRCS = [
  `${MEDIA}Sounds/Homepage/enter1.mp3`,
  `${MEDIA}Sounds/Homepage/enter2.mp3`,
  `${MEDIA}Sounds/Homepage/enter3.mp3`
];
const WATER_EXIT_SRCS = [
  `${MEDIA}Sounds/Homepage/exit1.mp3`,
  `${MEDIA}Sounds/Homepage/exit2.mp3`,
  `${MEDIA}Sounds/Homepage/exit3.mp3`
];
const hoverSfx = new Audio(UI_HOVER_SRC);   hoverSfx.preload = "none";  hoverSfx.volume = 0.35;
const toggleSfx = new Audio(UI_TOGGLE_SRC); toggleSfx.preload = "none"; toggleSfx.volume = 0.45;
const titleMainSfx  = new Audio(TITLE_MAIN_SRC);  titleMainSfx.preload  = "none"; titleMainSfx.volume  = 0.55;
const titleMetaSfx  = new Audio(TITLE_META_SRC);  titleMetaSfx.preload  = "none"; titleMetaSfx.volume  = 0.50;
const titleSheenSfx = new Audio(TITLE_SHEEN_SRC); titleSheenSfx.preload = "none"; titleSheenSfx.volume = 0.45;
const waterEnterSfx = WATER_ENTER_SRCS.map((src) => {
  const audio = new Audio(src);
  audio.preload = "none";
  audio.volume = 0.58;
  return audio;
});
const waterExitSfx = WATER_EXIT_SRCS.map((src) => {
  const audio = new Audio(src);
  audio.preload = "none";
  audio.volume = 0.58;
  return audio;
});
let lastWaterEnterSfxIndex = -1;
let lastWaterExitSfxIndex = -1;
const coreSfxRegistry = [
  [hoverSfx, 0.35],
  [toggleSfx, 0.45],
  [titleMainSfx, 0.55],
  [titleMetaSfx, 0.50],
  [titleSheenSfx, 0.45]
];
const waterSfxRegistry = [
  ...waterEnterSfx.map((audio) => [audio, 0.58]),
  ...waterExitSfx.map((audio) => [audio, 0.58])
];
const sfxRegistry = [
  ...coreSfxRegistry,
  ...waterSfxRegistry
];
let waterSfxPrimed = false;

function primeSfxEntries(entries){
  entries.forEach(([audio]) => {
    audio.preload = "auto";
    try { audio.load(); } catch {}
  });
}

function requestServiceWorkerAudioCache(group){
  if (!("serviceWorker" in navigator)) return;
  const postCacheRequest = (registration) => {
    const worker = navigator.serviceWorker.controller
      || registration?.active
      || registration?.waiting
      || registration?.installing;
    worker?.postMessage({ type: "CACHE_AUDIO_ASSETS", group });
  };

  window.setTimeout(() => {
    requestIdleWork(() => {
      if (navigator.serviceWorker.controller){
        postCacheRequest();
        return;
      }

      navigator.serviceWorker.ready.then(postCacheRequest).catch(() => {});
    }, 1800);
  }, 4500);
}

function primeSfxAfterUnlock(){
  primeSfxEntries(coreSfxRegistry);
  requestServiceWorkerAudioCache("core");
}

function primeWaterSfxAfterUnlock(){
  if (waterSfxPrimed || !audioUnlocked) return;
  waterSfxPrimed = true;
  primeSfxEntries(waterSfxRegistry);
  requestServiceWorkerAudioCache("water");
}

function applyMasterVolume(){
  userMuted = masterVolume <= 0.001;

  sfxRegistry.forEach(([audio, base]) => {
    audio.volume = base * masterVolume;
  });

  if (front) front.volume = masterVolume;
  if (back) back.volume = 0;
  if (salesBackgroundVideo) salesBackgroundVideo.volume = masterVolume;
  showcaseAmbientVideos.forEach((video) => {
    video.volume = masterVolume;
    if (waterManagedAmbientVideos.has(video) && userMuted) video.muted = true;
  });
}

function playSfx(a){
  // Mobile uses a cleaner HUD with no SFX layer.
  if (isMobileViewport && isMobileViewport()) return;
  if (exclusiveMediaPlayer) return;
  if (!audioUnlocked || userMuted) return;
  try { a.currentTime = 0; a.play().catch(() => {}); } catch {}
}

function pickRandomIndex(length, previousIndex = -1){
  if (length <= 1) return 0;

  let nextIndex = Math.floor(Math.random() * length);
  while (nextIndex === previousIndex){
    nextIndex = Math.floor(Math.random() * length);
  }
  return nextIndex;
}

function playRandomWaterTransitionSfx(direction){
  primeWaterSfxAfterUnlock();

  if (direction === "enter"){
    const nextIndex = pickRandomIndex(waterEnterSfx.length, lastWaterEnterSfxIndex);
    lastWaterEnterSfxIndex = nextIndex;
    playSfx(waterEnterSfx[nextIndex]);
    return;
  }

  if (direction === "exit"){
    const nextIndex = pickRandomIndex(waterExitSfx.length, lastWaterExitSfxIndex);
    lastWaterExitSfxIndex = nextIndex;
    playSfx(waterExitSfx[nextIndex]);
  }
}

function playTitleIn(){
  if (isMobileViewport && isMobileViewport()) return;
  if (!audioUnlocked || titleVisible) return;
  titleVisible = true;

  title.setAttribute("aria-hidden", "false");
  clearTitleClasses(); restartAnims();
  title.classList.add("play-in");

  setTimeout(enableSway, 820);

  playSfx(titleMainSfx);
  setTimeout(() => playSfx(titleMetaSfx), 220);

  const sheenStart = 1120;
  if (sheenTimer) clearTimeout(sheenTimer);
  sheenTimer = setTimeout(() => {
    title.classList.add("sheen");
    playSfx(titleSheenSfx);
    setTimeout(() => title.classList.remove("sheen"), 1400);
  }, sheenStart);
}

function playTitleOut(){
  if (isMobileViewport && isMobileViewport()) return;
  if (!audioUnlocked || !titleVisible) return;
  titleVisible = false;

  if (sheenTimer) clearTimeout(sheenTimer);
  disableSway();

  clearTitleClasses(); restartAnims();
  title.classList.add("play-out");
  playSfx(titleMetaSfx);

  setTimeout(() => {
    title.setAttribute("aria-hidden", "true");
    clearTitleClasses();
  }, 560);
}

/* Smart title placement */
function updateCinePosition(){
  const menuRect = wrapper.getBoundingClientRect();
  const safeRight = Math.max(0, menuRect.left - 44);

  const left = Math.min(
    Math.max(42, window.innerWidth * 0.09),
    Math.max(42, safeRight * 0.28)
  );

  const top = window.innerHeight * 0.40;
  title.style.setProperty("--cine-left", left + "px");
  title.style.setProperty("--cine-top", top + "px");
}
let cinePositionRaf = 0;
function queueCinePositionUpdate(){
  if (cinePositionRaf) return;
  cinePositionRaf = requestAnimationFrame(() => {
    cinePositionRaf = 0;
    updateCinePosition();
  });
}

queueCinePositionUpdate();
window.addEventListener("resize", queueCinePositionUpdate);

/* ================= INIT ================= */
let mode = localStorage.getItem(MODE_KEY);
if (mode !== "day" && mode !== "night") mode = "night";
applyModeClasses(mode);
showPoster(heroPosterEl);
showPoster(salesPosterEl);
primePoster(heroPosterEl, getHeroPosterKey(mode)).catch(() => {});
primePoster(salesPosterEl, SALES_POSTER_KEY).catch(() => {});

// ensure correct initial active layer
videoA.classList.add("active");

(async function init(){
  // start fully muted
  videoA.muted = true; videoB.muted = true;
  // load first mode via crossfade (gives consistent ready logic)
  await crossfadeToMode(mode);
  enforceAudioRouting();
  scheduleAmbientRouting();
})();

const connectionInfo = getConnectionInfo();
if (connectionInfo?.addEventListener){
  connectionInfo.addEventListener("change", () => applyMediaQuality(detectMediaQuality()));
}

[videoA, videoB].forEach((video) => {
  const recover = () => {
    if (video !== front) return;
    if (shouldSkipHeroPlayback(video)) return;
    window.setTimeout(() => {
      if (video !== front) return;
      if (switching || heroCulled || document.hidden || !heroVisible) return;
      ensureHeroPlayback();
    }, 60);
  };

  video.addEventListener("pause", recover);
  video.addEventListener("waiting", recover);
  video.addEventListener("stalled", recover);
  video.addEventListener("suspend", recover);
  video.addEventListener("canplay", () => {
    if (video !== front) return;
    if (switching || heroCulled || document.hidden || !heroVisible) return;
    ensureHeroPlayback();
  });
});

if (container && "IntersectionObserver" in window){
  const heroObserver = new IntersectionObserver((entries) => {
    heroVisible = entries.some((entry) => entry.isIntersecting);
    syncHeroCulling(heroVisible);
  }, {
    threshold: 0.01,
    rootMargin: "180px 0px 180px 0px"
  });

  heroObserver.observe(container);
} else if (container){
  const updateHeroVisibility = () => {
    const rect = container.getBoundingClientRect();
    heroVisible = rect.bottom >= -180 && rect.top <= window.innerHeight + 180;
    syncHeroCulling(heroVisible);
  };

  window.addEventListener("scroll", updateHeroVisibility, { passive: true });
  window.addEventListener("resize", updateHeroVisibility);
  requestAnimationFrame(updateHeroVisibility);
}

document.addEventListener("visibilitychange", () => {
  syncHeroCulling(!document.hidden && heroVisible);
});

window.addEventListener("pageshow", () => {
  syncHeroCulling(heroVisible);
});

window.addEventListener("pagehide", () => {
  syncHeroCulling(false);
});

/* ================= MOBILE ORIENTATION VIDEO SWAP =================
   If the device is treated as "mobile" and orientation flips, reload the current mode
   so portrait/landscape can use different video sources.
*/
let lastMobileOrientation = (isLandscape() ? "landscape" : "portrait");
let orientTimer = null;

function handleMobileOrientationSwap(){
  if (!isMobileViewport()) return;
  const now = (isLandscape() ? "landscape" : "portrait");
  if (now === lastMobileOrientation) return;
  lastMobileOrientation = now;
  if (switching) return;
  try { crossfadeToMode(mode).catch(() => {}); } catch {}
}

window.addEventListener("orientationchange", () => {
  if (orientTimer) clearTimeout(orientTimer);
  orientTimer = setTimeout(handleMobileOrientationSwap, 160);
});

window.addEventListener("resize", () => {
  if (orientTimer) clearTimeout(orientTimer);
  orientTimer = setTimeout(handleMobileOrientationSwap, 160);
});

/* ================= MODE SWITCH ================= */
toggle.addEventListener("click", async () => {
  if (switching) return;
  switching = true;

  playSfx(toggleSfx);

  container.classList.add("mode-switching");
  if (audioUnlocked) playTitleOut();

  await new Promise(r => setTimeout(r, 220));

  mode = (mode === "day") ? "night" : "day";
  localStorage.setItem(MODE_KEY, mode);
  applyModeClasses(mode);

  await crossfadeToMode(mode);

  await new Promise(r => setTimeout(r, 220));
  container.classList.remove("mode-switching");
  queueCinePositionUpdate();

  if (audioUnlocked) setTimeout(() => playTitleIn(), 180);

  switching = false;
});


function syncVolumeUI(){
  userMuted = masterVolume <= 0.001;
  document.body.classList.toggle("muted", !!userMuted);

  const percent = Math.round(masterVolume * 100);
  if (mobileVolumeWrap){
    mobileVolumeWrap.classList.toggle("is-muted", !!userMuted);
  }

  if (mobileVolumeInput){
    mobileVolumeInput.value = String(percent);
    mobileVolumeInput.style.setProperty("--range-fill", `${percent}%`);
    mobileVolumeInput.setAttribute("aria-valuetext", userMuted ? "Muted" : `${percent}% volume`);
  }
}

function setMasterVolume(nextVolume){
  const wasMuted = userMuted;
  masterVolume = Math.min(1, Math.max(0, nextVolume));
  localStorage.setItem(AUDIO_VOLUME_KEY, String(masterVolume));

  applyMasterVolume();
  syncVolumeUI();
  enforceAudioRouting();

  if (audioUnlocked && wasMuted && !userMuted){
    if (shouldKickMobilePlayback() && activeAmbientSection === "hero") kickMobileVideoPlayback();
    else resumeActiveAmbientPlayback();
  }
}

/* Mobile controls */
if (mobileThemeBtn){
  mobileThemeBtn.addEventListener("click", () => {
    try { toggle.click(); } catch {}
  });
}
if (mobileVolumeInput){
  mobileVolumeInput.addEventListener("input", (event) => {
    const next = Number(event.target.value) / 100;
    if (!Number.isFinite(next)) return;
    setMasterVolume(next);
  });
}
applyMasterVolume();
syncVolumeUI();

window.addEventListener("scroll", () => scheduleAmbientRouting(), { passive: true });
window.addEventListener("resize", () => {
  applyMediaQuality(detectMediaQuality());
  scheduleAmbientRouting();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  scheduleAmbientRouting(true);
});
window.addEventListener("pageshow", () => scheduleAmbientRouting(true));
requestAnimationFrame(() => scheduleAmbientRouting());

/* ================= AUDIO UNLOCK ================= */
const overlay = document.getElementById("audio-overlay");
overlay.addEventListener("pointerdown", async () => {
  audioUnlocked = true;
  primeSfxAfterUnlock();

  // Only active video plays audio
  enforceAudioRouting();

  // Ensure front plays (some browsers pause while muted)
  try { await front.play().catch(() => {}); } catch {}


  // Mobile: mimic the mode-switch \"kick\" so playback reliably resumes after unlocking audio
  kickMobileVideoPlayback();
  scheduleAmbientRouting(true);
// Post-audio fade on front
  front.classList.remove("audio-fade");
  void front.offsetWidth;
  front.classList.add("audio-fade");
  const ms = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--audio-fade-ms")) || 1600;
  setTimeout(() => front.classList.remove("audio-fade"), ms + 80);

  overlay.style.opacity = "0";
  overlay.style.transform = "scale(0.99)";
  setTimeout(() => overlay.remove(), 380);

  queueCinePositionUpdate();
  playTitleIn();
}, { once:true });

/* ================= MENU BUTTON ================= */
btn.addEventListener("click", () => {
  playSfx(toggleSfx);

  const willCollapse = !wrapper.classList.contains("collapsed");
  setMenuCollapsed(willCollapse, { syncTitle: true, remember: true });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (wrapper.classList.contains("collapsed")) return;
  if (document.querySelector(".carousel-player.is-open, .brand-chip.open")) return;

  setMenuCollapsed(true, { syncTitle: true, remember: true });
});

/* ================= LIVE PLAYERCOUNT (Option A) ================= */
const MC_SERVER = "198.244.176.14:26041"; // change if needed
const MC_REFRESH_MS = 30000;
const MC_STATUS_CACHE_KEY = "va_mc_status_v1";
const MC_STATUS_CACHE_TTL = 60000;
const mcMini = document.getElementById("mc-mini");
const quickAccessChipEl = document.getElementById("quick-access-chip");
let miniStatusTimer = 0;
let miniStatusController = null;

function clearMiniStatusTimer(){
  if (!miniStatusTimer) return;
  window.clearTimeout(miniStatusTimer);
  miniStatusTimer = 0;
}

function cancelMiniStatusRequest(){
  if (!miniStatusController) return;
  miniStatusController.abort();
  miniStatusController = null;
}

function shouldRefreshMiniStatus(){
  if (!mcMini || document.hidden) return false;
  if (!quickAccessChipEl) return true;
  return quickAccessChipEl.getClientRects().length > 0;
}

function renderMiniStatus(data){
  if (!mcMini || !data) return;

  if (data.online){
    const online = data.players?.online ?? 0;
    const max = data.players?.max ?? "?";
    mcMini.textContent = `Online | ${online}/${max}`;
    mcMini.classList.add("online");
    mcMini.classList.remove("offline");
    return;
  }

  mcMini.textContent = "Offline";
  mcMini.classList.add("offline");
  mcMini.classList.remove("online");
}

function readMiniStatusCache(){
  try{
    const raw = localStorage.getItem(MC_STATUS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.at || !parsed?.data) return null;
    if ((Date.now() - parsed.at) > MC_STATUS_CACHE_TTL) return null;
    return parsed.data;
  }catch{
    return null;
  }
}

function writeMiniStatusCache(data){
  try{
    localStorage.setItem(MC_STATUS_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      data
    }));
  }catch{}
}

function scheduleMiniStatusRefresh(delay = MC_REFRESH_MS){
  clearMiniStatusTimer();
  if (!shouldRefreshMiniStatus()) return;
  miniStatusTimer = window.setTimeout(() => {
    refreshMiniStatus();
  }, delay);
}

async function updateMiniStatus(){
  if (!mcMini || !shouldRefreshMiniStatus()) return;

  cancelMiniStatusRequest();
  const controller = new AbortController();
  miniStatusController = controller;

  try{
    const res = await fetch(`https://api.mcsrvstat.us/2/${encodeURIComponent(MC_SERVER)}`, {
      cache: "no-store",
      signal: controller.signal
    });
    const data = await res.json();
    if (miniStatusController !== controller) return;
    writeMiniStatusCache(data);

    if (data.online){
      const online = data.players?.online ?? 0;
      const max = data.players?.max ?? "?";
      mcMini.textContent = `Online | ${online}/${max}`;
      mcMini.classList.add("online");
      mcMini.classList.remove("offline");
    } else {
      mcMini.textContent = "Offline";
      mcMini.classList.add("offline");
      mcMini.classList.remove("online");
    }
  } catch(e){
    if (controller.signal.aborted) return;
    mcMini.textContent = "Status Error";
    mcMini.classList.add("offline");
    mcMini.classList.remove("online");
  } finally {
    if (miniStatusController === controller){
      miniStatusController = null;
    }
  }
}

async function refreshMiniStatus(force = false){
  clearMiniStatusTimer();
  if (!force && !shouldRefreshMiniStatus()) return;

  const cached = readMiniStatusCache();
  if (cached){
    renderMiniStatus(cached);
    if (!force){
      scheduleMiniStatusRefresh();
      return;
    }
  }

  await updateMiniStatus();
  scheduleMiniStatusRefresh();
}

const cachedMiniStatus = readMiniStatusCache();
if (cachedMiniStatus){
  renderMiniStatus(cachedMiniStatus);
}
refreshMiniStatus(!cachedMiniStatus);

document.addEventListener("visibilitychange", () => {
  if (document.hidden){
    clearMiniStatusTimer();
    cancelMiniStatusRequest();
    return;
  }
  refreshMiniStatus(true);
});

window.addEventListener("pageshow", () => refreshMiniStatus(true));
window.addEventListener("resize", () => scheduleMiniStatusRefresh(600));
window.addEventListener("pagehide", () => {
  clearMiniStatusTimer();
  cancelMiniStatusRequest();
});

/* ================= TOP CHIP DROPDOWN ================= */
const chip = document.querySelector(".topbar .brand-chip");
const dropdown = chip?.querySelector(".dropdown-content");

function isMobileUI(){
  return window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
}

function mobileQuickAccess(e){
  // Override the dropdown behavior on mobile.
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

  playSfx(toggleSfx);
  chip?.classList.remove("open");
}

if (chip && dropdown){
  chip.classList.remove("open");

  chip.addEventListener("click", (e) => {
    if (isMobileUI()){
      mobileQuickAccess(e);
      return;
    }

    if (dropdown.contains(e.target)) return;
    chip.classList.toggle("open");
  });

  document.addEventListener("pointerdown", (e) => {
    if (!chip.contains(e.target)) chip.classList.remove("open");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") chip.classList.remove("open");
  });
}

/* ================= QUICK SETUP COPY BUTTONS (COMPACT) ================= */
document.querySelectorAll(".qs-ipbtn[data-copy]").forEach(btn => {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const ip = btn.getAttribute("data-copy");
    const hint = btn.querySelector(".copyhint");

    try{
      await navigator.clipboard.writeText(ip);
      btn.classList.add("copied");
      if (hint) hint.textContent = "Copied";
    }catch{
      if (hint) hint.textContent = "Failed";
    }

    setTimeout(() => {
      btn.classList.remove("copied");
      if (hint) hint.textContent = "Copy";
    }, 1200);
  });
});

/* ================= MOBILE NAV SFX (visual only) ================= */
document.querySelectorAll(".mnav-item").forEach(el => {
  el.addEventListener("pointerenter", () => playSfx(hoverSfx));
  el.addEventListener("click", () => playSfx(toggleSfx));
});

/* ================= LITE YOUTUBE EMBED ================= */
(() => {
  const embeds = Array.from(document.querySelectorAll(".yt-lite[data-youtube-id]"));
  if (!embeds.length) return;

  function mountEmbed(button){
    if (!button || button.dataset.loaded === "true") return;
    button.dataset.loaded = "true";

    const youtubeId = button.dataset.youtubeId;
    if (!youtubeId) return;

    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
    iframe.width = "100%";
    iframe.height = "100%";
    iframe.loading = "lazy";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.title = "Vanilla Ascended trailer";

    button.replaceWith(iframe);
  }

  function loadThumbnail(button){
    const youtubeId = button.dataset.youtubeId;
    const bg = button.querySelector(".yt-lite__bg");
    if (!youtubeId || !bg || bg.dataset.thumbLoaded === "true") return;
    bg.dataset.thumbLoaded = "true";
    bg.style.backgroundImage =
      `linear-gradient(180deg, rgba(6,8,12,0.18), rgba(6,8,12,0.58)), url("https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg")`;
  }

  if ("IntersectionObserver" in window){
    const thumbObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadThumbnail(entry.target);
        observer.unobserve(entry.target);
      });
    }, {
      rootMargin: "900px 0px",
      threshold: 0.01
    });

    embeds.forEach((button) => {
      thumbObserver.observe(button);
      button.addEventListener("click", () => {
        loadThumbnail(button);
        mountEmbed(button);
      });
    });
    return;
  }

  embeds.forEach((button) => {
    loadThumbnail(button);
    button.addEventListener("click", () => mountEmbed(button));
  });
})();

(() => {
  const sales = document.getElementById("sales");
  if (!sales) return;

  let sectionActive = false;

  function syncSalesMedia(){
    if (salesBackgroundVideo){
      if (sectionActive){
        hydrateDeferredVideo(salesBackgroundVideo).then((video) => {
          if (!sectionActive || !video) return;

          const revealSalesVideo = () => {
            capturePoster(video, SALES_POSTER_KEY, salesPosterEl);
            hidePoster(salesPosterEl);
          };

          showPoster(salesPosterEl);
          primePoster(salesPosterEl, SALES_POSTER_KEY).catch(() => {});

          if (video.readyState >= 2){
            revealSalesVideo();
          } else {
            video.addEventListener("loadeddata", revealSalesVideo, { once: true });
            video.addEventListener("playing", revealSalesVideo, { once: true });
          }

          if (activeAmbientSection === "sales" && audioUnlocked && !userMuted){
            tryUnmuteAndPlay(video);
            return;
          }

          tryPlayMuted(video);
        });
      } else {
        pauseVideo(salesBackgroundVideo);
        showPoster(salesPosterEl);
      }
    }
  }

  function startSectionWork(){
    if (sectionActive) return;
    sectionActive = true;
    sales.classList.add("is-live");
    syncSalesMedia();
  }

  function stopSectionWork(){
    sectionActive = false;
    sales.classList.remove("is-live");
    syncSalesMedia();
  }

  if (!("IntersectionObserver" in window)){
    startSectionWork();
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (visible) startSectionWork();
    else stopSectionWork();
  }, {
    threshold: 0.01,
    rootMargin: "220px 0px 220px 0px"
  });

  observer.observe(sales);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden){
      pauseVideo(salesBackgroundVideo);
      return;
    }
    if (!sectionActive) return;
    syncSalesMedia();
  });

  window.addEventListener("pageshow", () => {
    if (!sectionActive) return;
    syncSalesMedia();
  });
})();

/* ================= TEXT POP REVEALS ================= */
(() => {
  const selectors = [
    "#sales .sl-lead",
    "#sales .video-strip-shell",
    "#sales .lead-quote",
    "#sales .lead-author",
    "#sales .lead-p"
  ];

  const targets = Array.from(document.querySelectorAll(selectors.join(",")));
  if (!targets.length) return;

  targets.forEach((el, index) => {
    el.classList.add("pop-reveal");
    el.style.setProperty("--pop-delay", `${(index % 4) * 85}ms`);
  });

  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced || !("IntersectionObserver" in window)){
    targets.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  let lastScrollY = window.scrollY;
  let scrollDirection = "down";

  function updateScrollDirection(){
    const nextScrollY = window.scrollY;
    if (nextScrollY > lastScrollY){
      scrollDirection = "down";
    } else if (nextScrollY < lastScrollY){
      scrollDirection = "up";
    }
    lastScrollY = nextScrollY;
  }

  window.addEventListener("scroll", updateScrollDirection, { passive: true });

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting){
        entry.target.classList.add("is-visible");
        return;
      }

      // Keep the copy and trailer revealed while scrolling down; reset on the way back up.
      if (scrollDirection === "up"){
        entry.target.classList.remove("is-visible");
      }
    });
  }, {
    threshold: 0,
    rootMargin: "-18% 0px -18% 0px"
  });

  targets.forEach((el) => revealObserver.observe(el));
})();

// Menu item click handler
document.querySelectorAll(".ui-item").forEach(el => {
  el.addEventListener("pointerenter", () => playSfx(hoverSfx));
  el.addEventListener("click", () => {
    const target = el.getAttribute("data-link");
    if (!target) return;

    // If it's one of the plaque CTAs, scroll to sales area.
    const sales = document.getElementById("sales");
    if (sales){
      const y = sales.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: y + 24, behavior: "smooth" });
    }
  });
});

/* ================= CAROUSEL ================= */
(() => {
  const carousel = document.querySelector("[data-carousel]");
  const track = carousel?.querySelector("[data-carousel-track]");
  const slides = track ? Array.from(track.children) : [];
  const visibleCount = 3;
  const totalCount = slides.length;
  const stepPercent = 100 / visibleCount;
  const centerSlot = Math.floor(visibleCount / 2);
  const sideStillFrameTime = 0.65;

  if (!carousel || !track || !slides.length) return;

  let index = 0;
  let autoplayId = null;
  let carouselVisible = !("IntersectionObserver" in window);
  let isAnimating = false;
  let overlayPlayer = null;
  let overlayPlayerCleanup = null;
  let lastSlideActivationId = "";
  let lastSlideActivationAt = 0;

  carousel.classList.toggle("is-live", carouselVisible);
  carousel.classList.toggle("is-paused", !carouselVisible);

  slides.forEach((slide, slideIndex) => {
    slide.dataset.carouselId = String(slideIndex);
    slide.addEventListener("pointerup", () => activateSlide(slide));
    slide.addEventListener("click", () => activateSlide(slide));
  });

  function warmCarouselStill(video, priority = "low"){
    if (!video) return Promise.resolve(null);
    if (hasShowcasePosterForVideo(video)) return Promise.resolve(video);

    return hydrateManagedStillFrame(video, { frameTime: sideStillFrameTime, priority, timeout: 5200 })
      .then((readyVideo) => {
        if (!readyVideo) return null;

        if (readyVideo.readyState >= 2){
          captureManagedShowcasePoster(readyVideo);
        }

        const slide = readyVideo.closest(".showcase-carousel__item");
        const isVisibleSide = carouselVisible && slide?.dataset.carouselRole === "side";

        if (isVisibleSide && readyVideo.readyState >= 2){
          freezeManagedVideoAtStart(readyVideo, sideStillFrameTime);
          scheduleSidePosterSwap(slide, readyVideo);
          return readyVideo;
        }

        if (hasShowcasePosterForVideo(readyVideo)){
          showManagedPosterFrame(readyVideo);
        } else {
          releaseManagedVideo(readyVideo);
        }

        return readyVideo;
      });
  }

  function warmCarouselStills(){
    const items = getItems();
    const immediateCount = Math.min(items.length, visibleCount + 1);

    items.slice(0, immediateCount).forEach((slide) => {
      const video = slide.querySelector("video");
      warmCarouselStill(video, "normal").catch(() => {});
    });

    if (items.length <= immediateCount) return;

    requestIdleWork(() => {
      items.slice(immediateCount).forEach((slide) => {
        const video = slide.querySelector("video");
        warmCarouselStill(video, "low").catch(() => {});
      });
    }, 3200);
  }

  function getItems(){
    return Array.from(track.children);
  }

  function setCarouselAnimationState(active){
    carousel.classList.toggle("is-animating", active);
  }

  function scheduleSidePosterSwap(slide, video, attempts = 24){
    if (attempts <= 0) return;

    window.setTimeout(() => {
      if (document.hidden || !carouselVisible || slide.dataset.carouselRole !== "side") return;
      if (video.readyState >= 2){
        captureManagedShowcasePoster(video);
      }
      if (showManagedPosterFrame(video)) return;
      scheduleSidePosterSwap(slide, video, attempts - 1);
    }, 220);
  }

  function syncVideos({ startOffset = 0, extraSideIndices = [] } = {}){
    const extraSides = new Set(extraSideIndices);

    getItems().forEach((slide, slideIndex) => {
      const video = slide.querySelector("video");
      if (!video) return;
      let role = "hidden";
      let sidePosition = "";

      if (slideIndex >= startOffset && slideIndex < startOffset + visibleCount){
        const slotIndex = slideIndex - startOffset;
        role = slotIndex === centerSlot ? "center" : "side";
        if (role === "side"){
          sidePosition = slotIndex < centerSlot ? "left" : "right";
        }
      } else if (extraSides.has(slideIndex)){
        role = "side";
        sidePosition = slideIndex < startOffset ? "left" : "right";
      }

      slide.dataset.carouselRole = role;
      slide.classList.toggle("is-center", role === "center");
      slide.classList.toggle("is-side", role === "side");
      slide.classList.toggle("is-left", sidePosition === "left");
      slide.classList.toggle("is-right", sidePosition === "right");

      if (!carouselVisible || document.hidden || role === "hidden"){
        releaseManagedVideo(video);
        return;
      }

      if (role === "center"){
        hydrateManagedVideo(video, { priority: "high" }).then((readyVideo) => {
          if (!readyVideo) return;
          if (document.hidden || !carouselVisible || slide.dataset.carouselRole !== "center"){
            releaseManagedVideo(readyVideo);
            return;
          }
          tryPlayMuted(readyVideo);
        });
        return;
      }

      if (showManagedPosterFrame(video)){
        return;
      }

      warmCarouselStill(video, "normal").then((readyVideo) => {
        if (!readyVideo) return;
        if (document.hidden || !carouselVisible || slide.dataset.carouselRole !== "side"){
          releaseManagedVideo(readyVideo);
          return;
        }
        if (readyVideo.readyState >= 2){
          freezeManagedVideoAtStart(readyVideo, sideStillFrameTime);
        } else {
          readyVideo.classList.add("showcase-managed-video--idle");
        }
        scheduleSidePosterSwap(slide, readyVideo);
      });
    });
  }

  function update(){
    setCarouselAnimationState(false);

    track.style.transform = "translateX(0)";
    syncVideos();
  }

  function normalizeIndex(nextIndex){
    return (nextIndex + totalCount) % totalCount;
  }

  function onTrackTransformEnd(callback){
    const handle = (event) => {
      if (event.target !== track || event.propertyName !== "transform") return;
      track.removeEventListener("transitionend", handle);
      callback();
    };

    track.addEventListener("transitionend", handle);
  }

  function animateNext(){
    if (isAnimating) return;
    isAnimating = true;
    setCarouselAnimationState(true);

    syncVideos({ startOffset: 1, extraSideIndices: [0] });
    void track.offsetWidth;

    track.style.transition = "none";
    track.style.transform = "translateX(0)";
    void track.offsetWidth;
    track.style.transition = "";

    const finish = () => {
      const first = track.firstElementChild;
      if (first) track.append(first);

      track.style.transition = "none";
      track.style.transform = "translateX(0)";
      void track.offsetWidth;
      track.style.transition = "";

      index = normalizeIndex(index + 1);
      isAnimating = false;
      update();
    };

    onTrackTransformEnd(finish);
    requestAnimationFrame(() => {
      track.style.transform = `translateX(-${stepPercent}%)`;
    });
  }

  function animatePrev(){
    if (isAnimating) return;
    isAnimating = true;
    setCarouselAnimationState(true);

    const last = track.lastElementChild;
    if (last) track.prepend(last);

    syncVideos({ startOffset: 0, extraSideIndices: [visibleCount] });
    void track.offsetWidth;

    track.style.transition = "none";
    track.style.transform = `translateX(-${stepPercent}%)`;
    void track.offsetWidth;
    track.style.transition = "";

    const finish = () => {
      index = normalizeIndex(index - 1);
      isAnimating = false;
      update();
    };

    onTrackTransformEnd(finish);
    track.style.transform = "translateX(0)";
  }

  function restartAutoplay(){
    if (autoplayId){
      window.clearInterval(autoplayId);
      autoplayId = null;
    }
    if (document.hidden || !carouselVisible) return;
    autoplayId = window.setInterval(() => animateNext(), 5500);
  }

  function stopAutoplay(){
    if (!autoplayId) return;
    window.clearInterval(autoplayId);
    autoplayId = null;
  }

  function pauseOverlayBackgroundAudio(){
    [front, back, salesBackgroundVideo, ...showcaseAmbientVideos].forEach((media) => {
      if (!media) return;
      pauseVideo(media);
    });

    sfxRegistry.forEach(([audio]) => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {}
    });
  }

  function sizeOverlayPlayerFrame(frame, referenceVideo){
    if (!frame) return;

    const videoWidth = referenceVideo?.videoWidth || 16;
    const videoHeight = referenceVideo?.videoHeight || 9;
    const ratio = videoWidth / videoHeight;
    const inset = Math.max(28, Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.035));
    const maxWidth = window.innerWidth - (inset * 2);
    const maxHeight = window.innerHeight - (inset * 2);

    let frameWidth = Math.min(maxWidth, maxHeight * ratio);
    let frameHeight = frameWidth / ratio;

    if (frameHeight > maxHeight){
      frameHeight = maxHeight;
      frameWidth = frameHeight * ratio;
    }

    frame.style.width = `${frameWidth}px`;
    frame.style.height = `${frameHeight}px`;
  }

  function closeOverlayPlayer({ restoreAutoplay = true } = {}){
    if (!overlayPlayer) return;

    const overlay = overlayPlayer;
    const cleanup = overlayPlayerCleanup;
    const video = overlay.querySelector("video");

    overlayPlayer = null;
    overlayPlayerCleanup = null;

    if (cleanup) cleanup();
    pauseVideo(video);
    if (exclusiveMediaPlayer === video){
      exclusiveMediaPlayer = null;
    }
    if (video){
      video.removeAttribute("src");
      try { video.load(); } catch {}
    }

    overlay.classList.remove("is-open");
    window.setTimeout(() => {
      overlay.remove();
    }, 220);

    enforceAudioRouting();
    resumeActiveAmbientPlayback();

    if (restoreAutoplay) restartAutoplay();
  }

  function openOverlayPlayer(slide){
    if (!slide || overlayPlayer) return;

    const sourceVideo = slide.querySelector("video");
    const source = sourceVideo?.currentSrc || getManagedVideoSource(sourceVideo);
    if (!source) return;

    stopAutoplay();
    playSfx(titleMainSfx);

    const overlay = document.createElement("div");
    overlay.className = "carousel-player";
    overlay.innerHTML = `
      <div class="carousel-player__frame" role="dialog" aria-modal="true" aria-label="Showcase video player">
        <button class="carousel-player__close" type="button" aria-label="Close video player">Close</button>
        <video class="carousel-player__video" controls playsinline preload="auto"></video>
      </div>
    `;

    const player = overlay.querySelector(".carousel-player__video");
    const closeBtn = overlay.querySelector(".carousel-player__close");
    const frame = overlay.querySelector(".carousel-player__frame");

    pauseOverlayBackgroundAudio();
    exclusiveMediaPlayer = player;

    player.src = source;
    player.loop = !!sourceVideo?.loop;
    player.muted = !audioUnlocked || userMuted;
    player.volume = player.muted ? 0 : masterVolume;

    try {
      if (sourceVideo && Number.isFinite(sourceVideo.currentTime)){
        player.currentTime = sourceVideo.currentTime;
      }
    } catch {}

    const syncFrameSize = () => {
      sizeOverlayPlayerFrame(frame, player.videoWidth ? player : sourceVideo);
    };

    const close = () => {
      closeOverlayPlayer();
      carousel.focus();
    };

    const onOverlayClick = (event) => {
      if (event.target === overlay) close();
    };

    const onKeydown = (event) => {
      if (event.key === "Escape") close();
    };

    player.addEventListener("play", pauseOverlayBackgroundAudio);
    player.addEventListener("loadedmetadata", syncFrameSize);
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", syncFrameSize);

    overlayPlayerCleanup = () => {
      player.removeEventListener("play", pauseOverlayBackgroundAudio);
      player.removeEventListener("loadedmetadata", syncFrameSize);
      closeBtn.removeEventListener("click", close);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("resize", syncFrameSize);
    };

    document.body.append(overlay);
    overlayPlayer = overlay;
    enforceAudioRouting();
    syncFrameSize();

    requestAnimationFrame(() => {
      overlay.classList.add("is-open");
    });

    try { player.play().catch(() => {}); } catch {}
    closeBtn.focus();
  }

  function activateSlide(slide){
    if (!slide) return;

    const now = performance.now();
    const slideId = slide.dataset.carouselId || "";
    if (slideId && slideId === lastSlideActivationId && (now - lastSlideActivationAt) < 280){
      return;
    }

    lastSlideActivationId = slideId;
    lastSlideActivationAt = now;

    if (slide.dataset.carouselRole === "center"){
      openOverlayPlayer(slide);
      return;
    }

    if (isAnimating || slide.dataset.carouselRole !== "side") return;

    playSfx(titleMainSfx);

    if (slide.classList.contains("is-left")){
      animatePrev();
      restartAutoplay();
      return;
    }

    if (slide.classList.contains("is-right")){
      animateNext();
      restartAutoplay();
    }
  }

  carousel.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft"){
      animatePrev();
      restartAutoplay();
    }

    if (event.key === "ArrowRight"){
      animateNext();
      restartAutoplay();
    }
  });

  carousel.addEventListener("mouseenter", () => {
    stopAutoplay();
  });

  carousel.addEventListener("mouseleave", restartAutoplay);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAutoplay();
    else restartAutoplay();
    syncVideos();
  });

  if ("IntersectionObserver" in window){
    const warmObserver = new IntersectionObserver((entries, observer) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      requestIdleWork(warmCarouselStills, 1400);
    }, {
      rootMargin: "1600px 0px",
      threshold: 0.01
    });

    warmObserver.observe(carousel);

    const carouselObserver = new IntersectionObserver((entries) => {
      carouselVisible = entries.some((entry) => entry.isIntersecting);
      carousel.classList.toggle("is-live", carouselVisible);
      carousel.classList.toggle("is-paused", !carouselVisible);
      if (carouselVisible) restartAutoplay();
      else stopAutoplay();
      syncVideos();
    }, {
      threshold: 0.15
    });

    carouselObserver.observe(carousel);
  }

  update();
  restartAutoplay();
})();

/* ================= WATER SUBMERSION TRANSITION ================= */
(() => {
  const section = showcaseWaterSection;
  if (!section) return;

  const overVideo = section.querySelector(".showcase-water__video--over");
  const underVideo = section.querySelector(".showcase-water__video--under");
  const media = [overVideo, underVideo].filter(Boolean);
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const waterPrimarySwitchProgress = 0.54;
  const waterLayerVisibleThreshold = 0.012;

  if (!media.length) return;

  let sectionVisible = false;
  let tickQueued = false;
  let lastScrollY = window.scrollY;
  let lastScrollDirection = 0;
  let lastRawProgress = 0;
  let commitRafId = 0;
  let commitTargetY = null;
  let commitMode = "";
  let commitDirection = 0;
  let touchStartY = null;
  let forwardReengageRequired = false;
  let forwardReengageUnlockAt = 0;
  let previousHtmlScrollBehavior = "";
  let previousBodyScrollBehavior = "";
  let lastWaterPlaybackState = "";
  let waterScrollTotal = 1;
  const waterClassCache = new Map();
  const waterStyleCache = new Map();
  let autoScrollConsumedForward = false;
  let autoScrollConsumedReverse = false;
  const waterForwardCommitTriggerProgress = 0.45;
  const waterReverseTriggerProgress = 1 - waterForwardCommitTriggerProgress;
  const waterStartRearmProgress = 0.04;
  const waterEndRearmProgress = 0.96;
  const waterCommitDuration = 1000;
  const waterForwardReengageCooldown = 180;
  const waterUnderPrepareLeadProgress = 0.12;
  const waterBoatScrollHoldProgress = waterForwardCommitTriggerProgress;

  function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
  }

  function trackScrollDirection(){
    const nextScrollY = window.scrollY;
    if (Math.abs(nextScrollY - lastScrollY) > 1){
      lastScrollDirection = nextScrollY > lastScrollY ? 1 : -1;
    }
    lastScrollY = nextScrollY;
  }

  function disableWaterCommitSmoothing(){
    previousHtmlScrollBehavior = document.documentElement.style.scrollBehavior;
    previousBodyScrollBehavior = document.body ? document.body.style.scrollBehavior : "";
    document.documentElement.style.scrollBehavior = "auto";
    if (document.body) document.body.style.scrollBehavior = "auto";
  }

  function restoreWaterCommitSmoothing(){
    document.documentElement.style.scrollBehavior = previousHtmlScrollBehavior;
    if (document.body) document.body.style.scrollBehavior = previousBodyScrollBehavior;
  }

  function refreshWaterScrollTotal(){
    waterScrollTotal = Math.max(1, section.offsetHeight - window.innerHeight);
    return waterScrollTotal;
  }

  function getWaterMetrics(){
    const total = waterScrollTotal || refreshWaterScrollTotal();
    const rect = section.getBoundingClientRect();
    const passed = clamp(-rect.top, 0, total);
    const rawProgress = total > 0 ? passed / total : 0;
    return { rect, total, rawProgress };
  }

  function getWaterDisplayProgress(rawProgress){
    const holdProgress = prefersReduced ? 0 : waterBoatScrollHoldProgress;
    if (holdProgress <= 0) return rawProgress;

    if (
      commitMode === "reverse" ||
      (
        commitMode !== "forward" &&
        lastScrollDirection < 0
      )
    ){
      if (rawProgress > waterReverseTriggerProgress) return 1;
      return clamp(rawProgress / waterReverseTriggerProgress, 0, 1);
    }

    return clamp((rawProgress - holdProgress) / (1 - holdProgress), 0, 1);
  }

  function lockForwardCommitUntilFreshInput(){
    forwardReengageRequired = true;
    forwardReengageUnlockAt = performance.now() + waterForwardReengageCooldown;
    autoScrollConsumedForward = true;
  }

  function unlockForwardCommitFromBoat(){
    const { rect, rawProgress } = getWaterMetrics();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    forwardReengageRequired = false;
    forwardReengageUnlockAt = 0;
    autoScrollConsumedForward = false;
    lastRawProgress = rawProgress;
    return true;
  }

  function syncWaterLiveClass(entry = null){
    const rect = entry?.boundingClientRect || section.getBoundingClientRect();
    setWaterClass("is-live", rect.bottom > 0 && rect.top < window.innerHeight);
  }

  function hasWaterFrame(video){
    return !!(video && (video.readyState >= 2 || hasShowcasePosterForVideo(video)));
  }

  function getWaterOverAlpha(progress){
    return 1 - clamp(progress * 1.22, 0, 1);
  }

  function getWaterUnderAlpha(progress){
    return clamp((progress - 0.18) / 0.54, 0, 1);
  }

  function isWaterLayerVisible(video, progress){
    if (video === overVideo) return getWaterOverAlpha(progress) > waterLayerVisibleThreshold;
    if (video === underVideo) return getWaterUnderAlpha(progress) > waterLayerVisibleThreshold;
    return false;
  }

  function syncWaterVideoAudio(overAudible, underAudible){
    setVideoAudioState(overVideo, overAudible);
    setVideoAudioState(underVideo, underAudible);
  }

  function cancelWaterCommit(){
    if (commitRafId){
      cancelAnimationFrame(commitRafId);
      commitRafId = 0;
    }
    commitTargetY = null;
    commitMode = "";
    commitDirection = 0;
    restoreWaterCommitSmoothing();
  }

  function finishWaterCommit(targetY){
    const completedMode = commitMode;
    const direction = commitDirection;
    const currentY = window.scrollY;
    const finalY =
      direction > 0
        ? Math.max(targetY, currentY)
        : direction < 0
          ? Math.min(targetY, currentY)
          : targetY;

    commitRafId = 0;
    commitTargetY = null;
    commitMode = "";
    commitDirection = 0;
    window.scrollTo(0, finalY);
    trackScrollDirection();
    queueWaterTransition();
    restoreWaterCommitSmoothing();

    if (completedMode === "reverse"){
      lockForwardCommitUntilFreshInput();
    }
  }

  function startWaterCommit(targetY, durationOverride = waterCommitDuration, mode = "commit"){
    if (!Number.isFinite(targetY)) return;
    const roundedTarget = Math.round(targetY);
    if (commitTargetY === roundedTarget) return;

    cancelWaterCommit();

    const startY = window.scrollY;
    const distance = roundedTarget - startY;
    if (Math.abs(distance) < 2){
      finishWaterCommit(roundedTarget);
      return;
    }

    commitTargetY = roundedTarget;
    commitMode = mode;
    commitDirection = distance > 0 ? 1 : -1;

    if (mode === "forward"){
      playRandomWaterTransitionSfx("enter");
    } else if (mode === "reverse"){
      playRandomWaterTransitionSfx("exit");
    }

    disableWaterCommitSmoothing();
    const duration = prefersReduced ? 0 : durationOverride;

    if (duration <= 0){
      finishWaterCommit(roundedTarget);
      return;
    }

    const startedAt = performance.now();
    const step = (now) => {
      if (commitTargetY !== roundedTarget){
        return;
      }

      const elapsed = Math.max(0, now - startedAt);
      const progress = clamp(elapsed / duration, 0, 1);
      const intendedY = startY + (distance * progress);
      const currentY = window.scrollY;

      if (commitDirection > 0 && currentY >= roundedTarget - 1){
        finishWaterCommit(currentY);
        return;
      }

      if (commitDirection < 0 && currentY <= roundedTarget + 1){
        finishWaterCommit(currentY);
        return;
      }

      const nextY =
        commitDirection > 0
          ? Math.max(currentY, Math.min(intendedY, roundedTarget))
          : Math.min(currentY, Math.max(intendedY, roundedTarget));

      window.scrollTo(0, nextY);

      if (progress >= 1){
        finishWaterCommit(roundedTarget);
        return;
      }

      commitRafId = requestAnimationFrame(step);
    };

    commitRafId = requestAnimationFrame(step);
  }

  function syncWaterPlayback(rawProgressHint = null, force = false, rawScrollProgressHint = null, sectionRectHint = null){
    const metrics = Number.isFinite(rawProgressHint) && Number.isFinite(rawScrollProgressHint) ? null : getWaterMetrics();
    const rawScrollProgress = Number.isFinite(rawScrollProgressHint) ? rawScrollProgressHint : metrics.rawProgress;
    const sectionRect = sectionRectHint || (metrics ? metrics.rect : section.getBoundingClientRect());
    const sectionInView = sectionRect.bottom > 0 && sectionRect.top < window.innerHeight;
    const shouldPlay = !document.hidden && sectionInView && !exclusiveMediaPlayer;
    const progress = Number.isFinite(rawProgressHint) ? rawProgressHint : getWaterDisplayProgress(rawScrollProgress);
    const activeVideo = progress < waterPrimarySwitchProgress ? overVideo : underVideo;
    const shouldPrepareUnderwater =
      shouldPlay &&
      rawScrollProgress >= Math.max(0, waterForwardCommitTriggerProgress - waterUnderPrepareLeadProgress);
    const underFrameReady = hasWaterFrame(underVideo);
    const overLayerVisible = isWaterLayerVisible(overVideo, progress) || (shouldPlay && !underFrameReady);
    const underLayerVisible = underFrameReady && isWaterLayerVisible(underVideo, progress);
    const playbackState = `${shouldPlay ? "play" : "idle"}:${activeVideo === underVideo ? "under" : "over"}:${overLayerVisible ? "over-visible" : "over-hidden"}:${underLayerVisible ? "under-visible" : "under-hidden"}:${underFrameReady ? "under-ready" : "under-waiting"}:${shouldPrepareUnderwater ? "prepare-under" : "wait-under"}`;
    const audibleVideo =
      shouldPlay && underLayerVisible && progress >= waterPrimarySwitchProgress
        ? underVideo
        : shouldPlay && overLayerVisible
          ? overVideo
          : null;

    syncWaterVideoAudio(audibleVideo === overVideo, audibleVideo === underVideo);

    if (!force && playbackState === lastWaterPlaybackState) return;
    lastWaterPlaybackState = playbackState;

    media.forEach((video) => {
      if (!video) return;

      if (!shouldPlay){
        releaseManagedVideo(video);
        return;
      }

      const layerVisible = video === overVideo ? overLayerVisible : underLayerVisible;
      const videoHasVisibleRange =
        video === overVideo
          ? layerVisible
          : (layerVisible || shouldPrepareUnderwater);

      if (!videoHasVisibleRange){
        releaseManagedVideo(video);
        return;
      }

      const priority =
        video === activeVideo || layerVisible || video === underVideo
          ? "high"
          : "low";

      hydrateManagedVideo(video, { priority }).then((readyVideo) => {
        if (!readyVideo) return;
        const { rawProgress: latestRawProgress } = getWaterMetrics();
        const latestProgress = getWaterDisplayProgress(latestRawProgress);
        const latestActiveVideo = latestProgress < waterPrimarySwitchProgress ? overVideo : underVideo;
        const latestUnderFrameReady = hasWaterFrame(underVideo);
        const latestShouldPrepareUnderwater =
          shouldPlay &&
          latestRawProgress >= Math.max(0, waterForwardCommitTriggerProgress - waterUnderPrepareLeadProgress);
        const latestLayerVisible =
          readyVideo === overVideo
            ? isWaterLayerVisible(readyVideo, latestProgress) || (shouldPlay && !latestUnderFrameReady)
            : latestUnderFrameReady && isWaterLayerVisible(readyVideo, latestProgress);

        if (document.hidden || !sectionVisible || exclusiveMediaPlayer){
          releaseManagedVideo(readyVideo);
          return;
        }

        if (readyVideo === latestActiveVideo || latestLayerVisible){
          try { readyVideo.play().catch(() => {}); } catch {}
          queueWaterTransition();
          return;
        }

        if (readyVideo === underVideo && latestShouldPrepareUnderwater){
          freezeManagedVideoAtStart(readyVideo);
          queueWaterTransition();
          return;
        }

        if (hasShowcasePosterForVideo(readyVideo)){
          releaseManagedVideo(readyVideo);
          return;
        }

        freezeManagedVideoAtStart(readyVideo);
        queueWaterTransition();
      });
    });
  }

  function isWaterCommitScrollKey(event){
    return (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "PageUp" ||
      event.key === "PageDown" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === " " ||
      event.code === "Space"
    );
  }

  function setWaterStyle(name, value){
    if (waterStyleCache.get(name) === value) return;
    waterStyleCache.set(name, value);
    section.style.setProperty(name, value);
  }

  function setWaterClass(name, active){
    if (waterClassCache.get(name) === active) return;
    waterClassCache.set(name, active);
    section.classList.toggle(name, active);
  }

  function updateWaterTransition(){
    tickQueued = false;

    const total = waterScrollTotal || refreshWaterScrollTotal();
    const rect = section.getBoundingClientRect();
    const isSectionInView = rect.bottom > 0 && rect.top < window.innerHeight;
    const passed = clamp(-rect.top, 0, total);
    const rawProgress = total > 0 ? passed / total : 0;
    const visualProgress = getWaterDisplayProgress(rawProgress);
    const progress = prefersReduced ? (rawProgress >= waterForwardCommitTriggerProgress ? 1 : 0) : visualProgress;
    const sectionStartY = window.scrollY + rect.top;
    const sectionEndY = window.scrollY + rect.top + total;

    const overAlpha = 1 - clamp(progress * 1.22, 0, 1);
    const underAlpha = clamp((progress - 0.18) / 0.54, 0, 1);
    const tintAlpha = clamp((progress - 0.08) / 0.34, 0, 1) * 0.92;
    const surfaceAlpha =
      clamp((progress - 0.08) / 0.18, 0, 1) *
      (1 - clamp((progress - 0.52) / 0.14, 0, 1)) *
      0.94;
    const bubbleAlpha = clamp((progress - 0.28) / 0.24, 0, 1) * 0.72;
    const causticsAlpha =
      clamp((progress - 0.46) / 0.18, 0, 1) *
      (1 - clamp((progress - 0.72) / 0.14, 0, 1)) *
      0.28;
    const veilAlpha =
      clamp((progress - 0.14) / 0.18, 0, 1) *
      (1 - clamp((progress - 0.74) / 0.18, 0, 1)) *
      0.70;

    const blurIn = clamp((progress - 0.12) / 0.18, 0, 1);
    const blurOut = 1 - clamp((progress - 0.62) / 0.22, 0, 1);
    const blur = prefersReduced ? 0 : blurIn * blurOut * 10.5;
    const drag = prefersReduced ? 0 : blurIn * blurOut * 16;
    const overCool = clamp((progress - 0.06) / 0.36, 0, 1);
    const underReveal = clamp((progress - 0.24) / 0.62, 0, 1);
    const underFrameReady = hasWaterFrame(underVideo);
    const effectiveUnderAlpha = underFrameReady ? underAlpha : 0;
    const effectiveUnderReveal = underFrameReady ? underReveal : 0;
    const effectiveOverAlpha = underFrameReady ? overAlpha : Math.max(overAlpha, 1 - effectiveUnderAlpha);

    setWaterClass("is-live", isSectionInView);
    setWaterClass("is-surface-active", surfaceAlpha > 0.012);
    setWaterClass("is-bubbles-active", bubbleAlpha > 0.012);
    setWaterClass("is-caustics-active", causticsAlpha > 0.012);
    setWaterClass("is-veil-active", veilAlpha > 0.012);

    setWaterStyle("--water-progress", progress.toFixed(4));
    setWaterStyle("--water-over-alpha", effectiveOverAlpha.toFixed(4));
    setWaterStyle("--water-under-alpha", effectiveUnderAlpha.toFixed(4));
    setWaterStyle("--water-tint-alpha", tintAlpha.toFixed(4));
    setWaterStyle("--water-surface-alpha", surfaceAlpha.toFixed(4));
    setWaterStyle("--water-bubble-alpha", bubbleAlpha.toFixed(4));
    setWaterStyle("--water-caustics-alpha", causticsAlpha.toFixed(4));
    setWaterStyle("--water-veil-alpha", veilAlpha.toFixed(4));
    setWaterStyle("--water-blur", blur.toFixed(3));
    setWaterStyle("--water-drag-y", `${drag.toFixed(3)}px`);
    setWaterStyle("--water-over-cool", overCool.toFixed(4));
    setWaterStyle("--water-under-reveal", effectiveUnderReveal.toFixed(4));

    syncWaterPlayback(progress, false, rawProgress, rect);

    const shouldForceWaterCommit =
      lastScrollDirection > 0 &&
      rawProgress >= waterForwardCommitTriggerProgress &&
      rawProgress < 0.985;

    const shouldForceWaterReverse =
      lastScrollDirection < 0 &&
      rawProgress <= waterReverseTriggerProgress &&
      rawProgress > 0.015;

    if (rawProgress <= waterStartRearmProgress && !forwardReengageRequired){
      autoScrollConsumedForward = false;
    }

    if (rawProgress >= waterEndRearmProgress){
      autoScrollConsumedReverse = false;
    }

    lastRawProgress = rawProgress;

    if ((!sectionVisible && !isSectionInView) || commitRafId || exclusiveMediaPlayer) return;

    if (shouldForceWaterCommit && !autoScrollConsumedForward && !forwardReengageRequired){
      autoScrollConsumedForward = true;
      startWaterCommit(sectionEndY, waterCommitDuration, "forward");
      return;
    }

    if (shouldForceWaterReverse && !autoScrollConsumedReverse){
      autoScrollConsumedReverse = true;
      startWaterCommit(sectionStartY, waterCommitDuration, "reverse");
    }
  }

  function queueWaterTransition(){
    if (!sectionVisible && !commitRafId) return;
    if (tickQueued) return;
    tickQueued = true;
    requestAnimationFrame(updateWaterTransition);
  }

  media.forEach((video) => {
    video.addEventListener("pause", () => {
      if (!sectionVisible || document.hidden || exclusiveMediaPlayer) return;
      window.setTimeout(() => syncWaterPlayback(null, true), 80);
    });
  });

  if ("IntersectionObserver" in window){
    const visibilityObserver = new IntersectionObserver((entries) => {
      sectionVisible = entries.some((entry) => entry.isIntersecting);
      syncWaterLiveClass(entries[0] || null);
      syncWaterPlayback(null, true);
      if (sectionVisible) queueWaterTransition();
    }, {
      threshold: 0.01,
      rootMargin: "720px 0px 1100px 0px"
    });

    visibilityObserver.observe(section);
  } else {
    sectionVisible = true;
    section.classList.add("is-live");
  }

  window.addEventListener("scroll", () => {
    trackScrollDirection();
    queueWaterTransition();
  }, { passive: true });
  window.addEventListener("wheel", (event) => {
    if (commitRafId){
      event.preventDefault();
      return;
    }

    if (!forwardReengageRequired || event.deltaY <= 1) return;

    if (performance.now() < forwardReengageUnlockAt){
      event.preventDefault();
      return;
    }

    unlockForwardCommitFromBoat();
  }, { passive: false });
  window.addEventListener("touchstart", (event) => {
    touchStartY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  window.addEventListener("touchmove", (event) => {
    const nextTouchY = event.touches[0]?.clientY ?? touchStartY;
    const deltaY = nextTouchY - (touchStartY ?? nextTouchY);

    if (commitRafId){
      event.preventDefault();
      return;
    }

    if (!forwardReengageRequired || deltaY >= -8) return;

    if (performance.now() < forwardReengageUnlockAt){
      event.preventDefault();
      return;
    }

    unlockForwardCommitFromBoat();
  }, { passive: false });
  window.addEventListener("touchend", () => {
    touchStartY = null;
  }, { passive: true });
  window.addEventListener("touchcancel", () => {
    touchStartY = null;
  }, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (commitRafId){
      if (!isWaterCommitScrollKey(event)) return;
      event.preventDefault();
      return;
    }

    if (
      forwardReengageRequired &&
      (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || (event.key === " " && !event.shiftKey))
    ){
      if (performance.now() < forwardReengageUnlockAt){
        event.preventDefault();
        return;
      }

      unlockForwardCommitFromBoat();
    }
  });
  window.addEventListener("resize", () => {
    refreshWaterScrollTotal();
    queueWaterTransition();
  });
  document.addEventListener("visibilitychange", () => {
    syncWaterPlayback(null, true);
    if (!document.hidden) queueWaterTransition();
  });
  window.addEventListener("pageshow", () => {
    queueWaterTransition();
    syncWaterPlayback(null, true);
  });

  refreshWaterScrollTotal();
  queueWaterTransition();
  syncWaterPlayback();
})();
