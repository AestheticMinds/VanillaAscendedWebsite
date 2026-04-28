const CACHE_VERSION = "v54";
const SHELL_CACHE = `va-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `va-static-${CACHE_VERSION}`;
const MEDIA_CACHE = `va-media-${CACHE_VERSION}`;
const RUNTIME_CACHE = `va-runtime-${CACHE_VERSION}`;
const POSTER_CACHE = "va-posters-v1";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=20260428-lazy-carousel-posters",
  "./main.js?v=20260428-lazy-carousel-posters",
  "./fonts/cormorant-garamond-latin.woff2"
];

const STATIC_ASSETS = [];

const CORE_AUDIO_ASSETS = [
  "./Media/ui_hover_1.mp3",
  "./Media/UI_Toggle_1.mp3",
  "./Media/UI_Title_Main.mp3",
  "./Media/UI_Title_Meta.mp3",
  "./Media/UI_Title_Sheen.mp3"
];

const WATER_AUDIO_ASSETS = [
  "./Media/Sounds/Homepage/enter1.mp3",
  "./Media/Sounds/Homepage/enter2.mp3",
  "./Media/Sounds/Homepage/enter3.mp3",
  "./Media/Sounds/Homepage/exit1.mp3",
  "./Media/Sounds/Homepage/exit2.mp3",
  "./Media/Sounds/Homepage/exit3.mp3"
];

const AUDIO_ASSETS = [
  ...CORE_AUDIO_ASSETS,
  ...WATER_AUDIO_ASSETS
];

const CACHE_LIMITS = {
  [RUNTIME_CACHE]: 80,
  [MEDIA_CACHE]: 36
};

function toUrl(path){
  return new URL(path, self.location.href).toString();
}

function toUrlList(paths){
  return paths.map(toUrl);
}

function isCacheableResponse(response){
  return !!response && (response.ok || response.type === "opaque");
}

async function cacheUrls(cacheName, urls, { reload = true, skipCached = false } = {}){
  const cache = await caches.open(cacheName);

  await Promise.all(urls.map(async (url) => {
    try{
      if (skipCached && await cache.match(url)) return;
      const request = new Request(url, { cache: reload ? "reload" : "default" });
      const response = await fetch(request);
      if (isCacheableResponse(response)){
        await cache.put(url, response.clone());
      }
    }catch{}
  }));
}

async function trimCache(cacheName, maxEntries){
  if (!maxEntries) return;

  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function putInCache(cacheName, request, response, event){
  if (!isCacheableResponse(response)) return;

  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());

  const maxEntries = CACHE_LIMITS[cacheName];
  if (event && maxEntries){
    event.waitUntil(trimCache(cacheName, maxEntries));
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await Promise.all([
      cacheUrls(SHELL_CACHE, toUrlList(SHELL_ASSETS)),
      cacheUrls(STATIC_CACHE, toUrlList(STATIC_ASSETS))
    ]);

    await self.skipWaiting();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_AUDIO_ASSETS") return;
  const assets =
    event.data.group === "core"
      ? CORE_AUDIO_ASSETS
      : event.data.group === "water"
        ? WATER_AUDIO_ASSETS
        : AUDIO_ASSETS;
  event.waitUntil(cacheUrls(MEDIA_CACHE, toUrlList(assets), { reload: false, skipCached: true }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, STATIC_CACHE, MEDIA_CACHE, RUNTIME_CACHE, POSTER_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, event, cacheName = RUNTIME_CACHE){
  try{
    const response = await fetch(request);
    await putInCache(cacheName, request, response, event);
    return response;
  }catch{
    return (
      (await caches.match(request)) ||
      (await caches.match(toUrl("./index.html"))) ||
      Response.error()
    );
  }
}

async function cacheFirst(request, event, cacheName = STATIC_CACHE){
  const cached = await caches.match(request);
  if (cached) return cached;

  try{
    const response = await fetch(request);
    await putInCache(cacheName, request, response, event);
    return response;
  }catch{
    return Response.error();
  }
}

async function staleWhileRevalidate(request, event, cacheName = RUNTIME_CACHE){
  const cached = await caches.match(request);

  const networkFetch = fetch(request)
    .then(async (response) => {
      await putInCache(cacheName, request, response, event);
      return response;
    })
    .catch(() => null);

  if (cached){
    event.waitUntil(networkFetch);
    return cached;
  }

  return (await networkFetch) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const pathname = url.pathname;
  const destination = request.destination;

  const isDocument = request.mode === "navigate" || destination === "document";
  if (sameOrigin && isDocument){
    event.respondWith(networkFirst(request, event, RUNTIME_CACHE));
    return;
  }

  if (sameOrigin && (destination === "script" || destination === "style")){
    event.respondWith(networkFirst(request, event, RUNTIME_CACHE));
    return;
  }

  const isFont = destination === "font" || /\.(woff2?|ttf|otf)$/i.test(pathname);
  if (sameOrigin && isFont){
    event.respondWith(cacheFirst(request, event, STATIC_CACHE));
    return;
  }

  const isImage = destination === "image" || /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(pathname);
  const isTrustedRemoteImage = url.hostname === "i.ytimg.com";
  if ((sameOrigin || isTrustedRemoteImage) && isImage){
    event.respondWith(staleWhileRevalidate(request, event, sameOrigin ? STATIC_CACHE : RUNTIME_CACHE));
    return;
  }

  const isAudio = destination === "audio" || /\.(mp3|wav|ogg|m4a)$/i.test(pathname);
  if (sameOrigin && isAudio){
    event.respondWith(cacheFirst(request, event, MEDIA_CACHE));
    return;
  }

  const isVideo = destination === "video" || /\.(mp4|webm|mov|m4v)$/i.test(pathname);
  if (sameOrigin && isVideo){
    return;
  }

  if (sameOrigin && /\/Media\//i.test(pathname)){
    event.respondWith(staleWhileRevalidate(request, event, MEDIA_CACHE));
  }
});
